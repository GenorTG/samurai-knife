/**
 * The workflow worker's HTTP client: the app's SSRF-safe transport (src/lib/net/safe-fetch.ts: scheme/port/credential
 * checks, DNS answers checked against the policy, connection pinned to the checked address) with every method, binary
 * bodies, redirects re-checked hop by hop (credentials dropped when the origin changes), a body cap and a timeout.
 */
import { checkUrl, OutboundError, nodeTransport, resolveAllowed, type OutboundPolicy } from "../../net/safe-fetch";
import { NodeError, type HttpClient } from "../engine/node-api";
import type { WorkerPolicy } from "./protocol";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE = ["authorization", "cookie", "proxy-authorization"];

export function toOutboundPolicy(policy: WorkerPolicy): OutboundPolicy {
  return { allowPrivate: policy.allowPrivate, ports: policy.ports ? new Set(policy.ports) : null, httpsOnly: policy.httpsOnly };
}

export function policyHttp(policy: OutboundPolicy, runSignal: AbortSignal): HttpClient {
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new NodeError(`"${request.url}" is not a valid URL.`);
    }
    let method = request.method.toUpperCase();
    let body = request.body;
    let headers: Record<string, string> = { "user-agent": "SmartKnife-Workflows/1", ...request.headers };
    const maxRedirects = request.followRedirects === false ? 0 : Math.max(0, Math.min(10, request.maxRedirects ?? 5));
    const maxBytes = request.maxBytes ?? 32 * 1024 * 1024;
    const signal = AbortSignal.any([runSignal, AbortSignal.timeout(request.timeoutMs ?? 30_000)]);
    for (let hop = 0; ; hop += 1) {
      let response;
      try {
        checkUrl(url, policy);
        const addresses = await resolveAllowed(url, policy);
        response = await nodeTransport({ url, ip: addresses[0], addresses, method, headers, body, signal });
      } catch (error) {
        if (signal.aborted && !runSignal.aborted) throw new NodeError(`The request to ${url.host} took longer than ${Math.round((request.timeoutMs ?? 30_000) / 1000)} s.`);
        if (error instanceof OutboundError) throw new NodeError(error.message, { description: error.kind === "refused" ? "Workflows may only call public addresses (an administrator can allow private networks for an account)." : undefined });
        throw new NodeError(`Could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const location = response.headers.location;
      if (REDIRECTS.has(response.status) && location && hop < maxRedirects) {
        response.close();
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new NodeError(`${url.host} redirected to an invalid address.`);
        }
        if (next.origin !== url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !SENSITIVE.includes(name.toLowerCase())));
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"));
        }
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for await (const chunk of response.body) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            response.close();
            throw new NodeError(`The answer from ${url.host} is larger than ${Math.round(maxBytes / 1048576)} MB.`);
          }
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof NodeError) throw error;
        throw new NodeError(`Reading the answer from ${url.host} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) out[name] = value;
      return { status: response.status, headers: out, body: Buffer.concat(chunks), url: url.toString() };
    }
  };
}
