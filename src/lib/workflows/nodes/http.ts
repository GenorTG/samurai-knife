/** HTTP Request and GraphQL (metadata: src/lib/workflows/catalog/network.ts). Transport: `services.http` (policy-checked). */
import { randomBytes } from "node:crypto";
import { NodeError, type CredentialData, type ExecuteContext, type HttpRequest, type HttpResponse, type NodeImpl } from "../engine/node-api";
import type { Item, JsonObject } from "../types";
import { checkHeader, sendAuthorized } from "./auth";
import { binaryOf, extensionFor, isPlainObject, jsonParam, keyValues, setPath } from "./util";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function checkedUrl(raw: unknown): URL {
  const text = String(raw ?? "").trim();
  if (!text) throw new NodeError("Set the URL.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new NodeError(`"${text}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NodeError("Only http:// and https:// URLs can be called.");
  return url;
}

function multipart(fields: Record<string, string>, files: { field: string; fileName: string; mimeType: string; bytes: Uint8Array }[]): { body: Uint8Array; contentType: string } {
  const boundary = `----smartknife${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  const quote = (value: string) => value.replace(/["\r\n\\]/g, "_");
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.field)}"; filename="${quote(file.fileName)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`, "utf8"));
    chunks.push(Buffer.from(file.bytes));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Field values typed loosely: "12" stays text; JSON-looking objects/lists are parsed. */
function jsonFieldValue(value: string): unknown {
  const text = value.trim();
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function decodeResponse(ctx: ExecuteContext, response: HttpResponse, format: string, outputField: string): { kind: "json"; value: unknown } | { kind: "text"; value: string } | { kind: "file"; item: Item } {
  const type = (response.headers["content-type"] ?? "").toLowerCase();
  const isJson = /[/+]json\b/.test(type);
  const isText = isJson || /^text\/|xml|javascript|x-www-form-urlencoded/.test(type);
  const wantFile = format === "file" || (format === "auto" && !isText && response.body.byteLength > 0);
  if (wantFile) {
    const path = new URL(response.url).pathname;
    const fileName = decodeURIComponent(path.split("/").pop() || "") || `download.${extensionFor(type || "application/octet-stream")}`;
    const ref = ctx.services.blobs.put(response.body, { mimeType: type.split(";")[0] || "application/octet-stream", fileName });
    return { kind: "file", item: { json: {}, binary: { [outputField]: ref } } };
  }
  const text = new TextDecoder().decode(response.body);
  if (format === "json" || (format === "auto" && isJson)) {
    if (!text.trim()) return { kind: "json", value: {} };
    try {
      return { kind: "json", value: JSON.parse(text) as unknown };
    } catch {
      if (format === "json") throw new NodeError("The response is not valid JSON.", { description: text.slice(0, 300) });
    }
  }
  return { kind: "text", value: text };
}

function errorFor(response: HttpResponse): NodeError {
  const text = new TextDecoder().decode(response.body.slice(0, 4096));
  let detail = text.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message = parsed.message ?? (isPlainObject(parsed.error) ? parsed.error.message : parsed.error) ?? parsed.error_description;
    if (typeof message === "string") detail = message;
  } catch {
    // not JSON: keep the text
  }
  return new NodeError(`The service answered HTTP ${response.status}.`, { httpCode: response.status, description: detail.slice(0, 500) || undefined });
}

async function credentialFor(ctx: ExecuteContext): Promise<CredentialData | null> {
  return ctx.param("authentication") === "credential" ? ctx.credential("auth") : null;
}

const httpRequestNode: NodeImpl = {
  type: "core.http-request",
  async execute(ctx) {
    const credential = await credentialFor(ctx);
    const customBody = credential?.type === "httpCustomAuth" ? (() => {
      const spec = jsonParam(credential.data.json ?? "{}", "The custom auth JSON");
      return isPlainObject(spec) && isPlainObject(spec.body) ? spec.body : null;
    })() : null;
    const out: Item[] = [];
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const options0 = ctx.param<Record<string, unknown>>("options", 0) ?? {};
    const batchSize = Math.max(0, Math.floor(Number(options0.batchSize) || 0));
    const batchInterval = Math.max(0, Math.min(60_000, Math.floor(Number(options0.batchInterval) || 0)));
    for (let index = 0; index < items.length; index += 1) {
      if (ctx.signal.aborted) break;
      if (batchSize && index > 0 && index % batchSize === 0 && batchInterval) await sleep(batchInterval, ctx.signal);
      const item = items[index];
      const options = ctx.param<Record<string, unknown>>("options", index) ?? {};
      const method = String(ctx.param("method", index) ?? "GET").toUpperCase();
      if (!METHODS.has(method)) throw new NodeError(`Unknown method ${method}.`);
      const build = (): HttpRequest => {
        const url = checkedUrl(ctx.param("url", index));
        if (ctx.param<boolean>("sendQuery", index)) for (const [name, value] of Object.entries(keyValues(ctx.param("query", index)))) url.searchParams.append(name, value);
        const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
        let body: string | Uint8Array | undefined;
        if (ctx.param<boolean>("sendBody", index) && method !== "GET" && method !== "HEAD") {
          const type = ctx.param<string>("contentType", index);
          if (type === "json") {
            let value: unknown =
              ctx.param("bodyMode", index) === "json"
                ? jsonParam(ctx.param("jsonBody", index), "The JSON body")
                : Object.fromEntries(Object.entries(keyValues(ctx.param("jsonFields", index))).map(([k, v]) => [k, jsonFieldValue(v)]));
            if (customBody && isPlainObject(value)) value = { ...value, ...customBody };
            body = JSON.stringify(value);
            headers["content-type"] = "application/json";
          } else if (type === "form") {
            body = new URLSearchParams(keyValues(ctx.param("bodyFields", index))).toString();
            headers["content-type"] = "application/x-www-form-urlencoded";
          } else if (type === "multipart") {
            const files = Object.entries(keyValues(ctx.param("multipartFiles", index))).map(([field, property]) => {
              const ref = binaryOf(item, property, ctx.node.name);
              return { field, fileName: ref.fileName ?? "file", mimeType: ref.mimeType, bytes: ctx.services.blobs.get(ref) };
            });
            const built = multipart(keyValues(ctx.param("bodyFields", index)), files);
            body = built.body;
            headers["content-type"] = built.contentType;
          } else if (type === "raw") {
            body = String(ctx.param("rawBody", index) ?? "");
            headers["content-type"] = String(ctx.param("rawContentType", index) || "text/plain");
          } else if (type === "binary") {
            const ref = binaryOf(item, String(ctx.param("binaryProperty", index) || "data"), ctx.node.name);
            body = ctx.services.blobs.get(ref);
            headers["content-type"] = ref.mimeType;
          }
        }
        if (ctx.param<boolean>("sendHeaders", index)) {
          for (const [name, value] of Object.entries(keyValues(ctx.param("headers", index)))) {
            checkHeader(name, value);
            for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
            headers[name] = value;
          }
        }
        return {
          url: url.toString(),
          method,
          headers,
          body,
          followRedirects: options.followRedirects !== false,
          maxRedirects: Math.max(0, Math.min(10, Number(options.maxRedirects ?? 5))),
          timeoutMs: Math.max(1000, Math.min(300_000, Number(options.timeout) || 30_000)),
          maxBytes: ctx.limits.maxHttpBytes,
        };
      };
      let response: HttpResponse;
      try {
        response = await sendAuthorized(ctx, build, credential);
      } catch (error) {
        if (error instanceof NodeError) throw error;
        throw new NodeError(error instanceof Error ? error.message : String(error), { itemIndex: index });
      }
      if (response.status >= 400 && !options.neverError) throw errorFor(response);
      const outputField = String(options.outputField || "data");
      const decoded = decodeResponse(ctx, response, String(options.response ?? "auto"), outputField);
      const full = Boolean(options.fullResponse);
      const wrap = (json: JsonObject, binary?: Item["binary"]): Item => ({
        json: full ? { statusCode: response.status, headers: response.headers, body: json } : json,
        ...(binary ? { binary } : {}),
        pairedItem: index,
      });
      if (decoded.kind === "file") out.push(wrap({}, decoded.item.binary));
      else if (decoded.kind === "text") {
        const json: JsonObject = {};
        setPath(json, outputField, decoded.value);
        out.push(wrap(json));
      } else if (Array.isArray(decoded.value) && options.splitIntoItems !== false && !full) {
        for (const entry of decoded.value) out.push(wrap(isPlainObject(entry) ? entry : { value: entry }));
      } else if (isPlainObject(decoded.value)) out.push(wrap(decoded.value));
      else out.push(wrap({ [outputField]: decoded.value }));
    }
    return [out];
  },
};

const graphqlNode: NodeImpl = {
  type: "core.graphql",
  async execute(ctx) {
    const credential = await credentialFor(ctx);
    const out: Item[] = [];
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    for (let index = 0; index < items.length; index += 1) {
      const variables = jsonParam(ctx.param("variables", index), "Variables");
      const operationName = String(ctx.param("operationName", index) ?? "").trim();
      const build = (): HttpRequest => {
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
        for (const [name, value] of Object.entries(keyValues(ctx.param("headers", index)))) {
          checkHeader(name, value);
          headers[name] = value;
        }
        return {
          url: checkedUrl(ctx.param("endpoint", index)).toString(),
          method: "POST",
          headers,
          body: JSON.stringify({ query: String(ctx.param("query", index) ?? ""), variables: isPlainObject(variables) ? variables : {}, ...(operationName ? { operationName } : {}) }),
          followRedirects: false,
          timeoutMs: 60_000,
          maxBytes: ctx.limits.maxHttpBytes,
        };
      };
      const response = await sendAuthorized(ctx, build, credential);
      if (response.status >= 400) throw errorFor(response);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(response.body));
      } catch {
        throw new NodeError("The GraphQL endpoint did not answer with JSON.");
      }
      if (isPlainObject(body) && Array.isArray(body.errors) && body.errors.length && !body.data) {
        const first = body.errors[0];
        throw new NodeError(`GraphQL error: ${isPlainObject(first) && typeof first.message === "string" ? first.message : JSON.stringify(first)}`);
      }
      out.push({ json: isPlainObject(body) ? body : { data: body }, pairedItem: index });
    }
    return [out];
  },
};

export const HTTP_IMPLS: NodeImpl[] = [httpRequestNode, graphqlNode];
