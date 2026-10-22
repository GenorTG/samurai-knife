/**
 * Webhook and resume calls (docs/WORKFLOWS.md "Triggers"): the only workflow routes without a session or the Origin
 * guard. They authenticate by the workflow's unguessable token (and the Webhook node's own auth), are rate limited per
 * address and per workflow, and never show a run's internal errors.
 *
 * The routes share the app's origin, so: the caller's `Cookie` header never reaches the run (a browser visiting a
 * hook URL would otherwise hand its Smart Knife session to whoever wrote the workflow), a run can never set a cookie,
 * and every answer is served under `Content-Security-Policy: sandbox` (an HTML answer renders as an opaque origin
 * without scripts: no access to the app's pages or APIs).
 */
import { timingSafeEqual } from "node:crypto";
import { readBodyCapped } from "@/lib/accounts/http";
import { clientIp } from "@/lib/accounts/network";
import { consumeLimits, LIMITS } from "@/lib/accounts/rate-limit";
import { nodeMeta } from "../catalog/index";
import type { HookResponse, Item, Workflow, WorkflowNode } from "../types";
import { matchHookPath } from "../validate";
import { appBaseUrl, startRun } from "./runner";
import { findByTokenHash, findWaitByResumeHash } from "./trigger-index";
import { getCredential, getRun, getWorkflow, tokenHash } from "./store";
import type { BlobPayload } from "../worker/protocol";
import { randomBytes } from "node:crypto";

const MAX_BODY = () => Math.max(1024, Number.parseInt(process.env.KNIFE_WF_HOOK_MAX_BYTES ?? "", 10) || 16 * 1024 * 1024);
const BLOCKED_RESPONSE_HEADERS = /^(?:set-cookie|set-cookie2|content-security-policy|content-security-policy-report-only|strict-transport-security|x-frame-options|x-content-type-options|cross-origin-.*|access-control-allow-credentials|transfer-encoding|content-length|connection|keep-alive|upgrade|trailer|server)$/i;

const SAFE_HEADERS: [string, string][] = [
  ["Content-Security-Policy", "sandbox; default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:; form-action *; frame-ancestors 'none'"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["Cache-Control", "no-store"],
];

function answer(response: HookResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (!BLOCKED_RESPONSE_HEADERS.test(name)) headers.set(name, value);
  for (const [name, value] of SAFE_HEADERS) headers.set(name, value);
  const status = response.status >= 200 && response.status <= 599 ? response.status : 200;
  const body = [204, 205, 304].includes(status) ? null : response.bodyBase64 !== undefined ? Buffer.from(response.bodyBase64, "base64") : (response.body ?? null);
  return new Response(body, { status, headers });
}

const jsonAnswer = (status: number, value: unknown, extra: Record<string, string> = {}) =>
  answer({ status, headers: { "content-type": "application/json; charset=utf-8", ...extra }, body: JSON.stringify(value) });

const notFound = () => jsonAnswer(404, { error: "not_found", message: "No workflow listens at this address." });

/* ----------------------------------------------------------------------------------------------- test listeners */

interface Listener {
  account: string;
  workflow: Workflow;
  expires: number;
  resolve: (runId: string) => void;
}

const LISTEN_KEY = Symbol.for("samurai-knife.workflow-listeners.v1");

function listeners(): Map<string, Listener> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Listener> | undefined>;
  return (holder[LISTEN_KEY] ??= new Map());
}

/** The editor's "Listen for a test call": the next call to a test URL of this workflow runs `workflow` (the editor's draft). */
export function listenForTestCall(account: string, workflow: Workflow, timeoutMs = 110_000): Promise<string | null> {
  const key = `${account}/${workflow.id}`;
  listeners().get(key)?.resolve("");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (listeners().get(key)?.resolve === done) listeners().delete(key);
      resolve(null);
    }, timeoutMs);
    const done = (runId: string) => {
      clearTimeout(timer);
      resolve(runId || null);
    };
    listeners().set(key, { account, workflow, expires: Date.now() + timeoutMs, resolve: done });
  });
}

export function stopListening(account: string, workflowId: string): void {
  const key = `${account}/${workflowId}`;
  listeners().get(key)?.resolve("");
  listeners().delete(key);
}

/* --------------------------------------------------------------------------------------------------- requests */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function checkAuth(account: string, node: WorkflowNode, request: Request): Response | null {
  const mode = String(node.parameters.authentication ?? "none");
  if (mode === "none") return null;
  const slot = mode === "header" ? "headerAuth" : mode === "basic" ? "basicAuth" : "bearerAuth";
  const id = node.credentials?.[slot];
  const credential = id ? getCredential(account, id) : null;
  // A webhook set to require auth but without its credential refuses everyone (fails closed).
  if (!credential) return jsonAnswer(401, { error: "unauthorized" });
  const data = credential.data;
  let ok = false;
  if (mode === "header") ok = safeEqual(request.headers.get(String(data.name ?? "")) ?? "", String(data.value ?? ""));
  else if (mode === "bearer") ok = safeEqual(request.headers.get("authorization") ?? "", `Bearer ${String(data.token ?? "")}`);
  else if (mode === "basic") {
    const expected = `Basic ${Buffer.from(`${String(data.user ?? "")}:${String(data.password ?? "")}`).toString("base64")}`;
    ok = safeEqual(request.headers.get("authorization") ?? "", expected);
    if (!ok) return jsonAnswer(401, { error: "unauthorized" }, { "www-authenticate": 'Basic realm="Webhook"' });
  }
  return ok ? null : jsonAnswer(401, { error: "unauthorized" });
}

function blobPayload(bytes: Uint8Array, mimeType: string, fileName?: string): BlobPayload {
  const id = randomBytes(9).toString("hex");
  return { ref: { id, mimeType: mimeType || "application/octet-stream", ...(fileName ? { fileName: fileName.slice(0, 200) } : {}), fileSize: bytes.byteLength }, bytes };
}

async function requestItem(request: Request, url: URL, params: Record<string, string>, rawBody: boolean): Promise<{ item: Item; blobs: BlobPayload[] } | Response> {
  const read = await readBodyCapped(request, MAX_BODY());
  if ("tooLarge" in read) return jsonAnswer(413, { error: "payload_too_large" });
  if ("failed" in read) return jsonAnswer(400, { error: "invalid_body" });
  const bytes = read.bytes;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name !== "cookie") headers[name] = value;
  });
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of url.searchParams) {
    const existing = query[name];
    query[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  const blobs: BlobPayload[] = [];
  const binary: Item["binary"] = {};
  let body: unknown = {};
  if (bytes.byteLength) {
    if (/[/+]json\b/.test(type)) {
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return jsonAnswer(400, { error: "invalid_json", message: "The body is not valid JSON." });
      }
    } else if (type.startsWith("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
    } else if (type.startsWith("multipart/form-data")) {
      let form: FormData;
      try {
        form = await new Response(Buffer.from(bytes), { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
      } catch {
        return jsonAnswer(400, { error: "invalid_body", message: "The multipart body could not be read." });
      }
      const fields: Record<string, string> = {};
      let fileIndex = 0;
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") fields[name] = value;
        else {
          const payload = blobPayload(new Uint8Array(await value.arrayBuffer()), value.type, value.name);
          blobs.push(payload);
          binary[fileIndex === 0 && !(name in binary) ? name : `${name}${fileIndex}`] = payload.ref;
          fileIndex += 1;
        }
      }
      body = fields;
    } else if (type.startsWith("text/") || /xml|javascript/.test(type)) {
      body = new TextDecoder().decode(bytes);
    } else {
      const payload = blobPayload(bytes, type.split(";")[0], "body");
      blobs.push(payload);
      binary.data = payload.ref;
    }
    if (rawBody && !binary.data) {
      const payload = blobPayload(bytes, type.split(";")[0] || "application/octet-stream", "body");
      blobs.push(payload);
      binary.data = payload.ref;
    }
  }
  const item: Item = { json: { headers, params, query, body, method: request.method, path: url.pathname, receivedAt: new Date().toISOString() }, ...(Object.keys(binary).length ? { binary } : {}) };
  return { item, blobs };
}

/** `/api/hooks/<token>/<path>` (production, active workflows) and `/api/hooks-test/<token>/<path>` (listening editor). */
export async function handleHook(request: Request, token: string, path: string, test: boolean): Promise<Response> {
  const ip = clientIp(request);
  const byIp = consumeLimits([LIMITS.hookIp(ip)]);
  if (!byIp.ok) return jsonAnswer(429, { error: "rate_limited" }, { "retry-after": String(byIp.retryAfterSeconds) });
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return notFound();
  const entry = findByTokenHash(tokenHash(token));
  if (!entry) return notFound();
  let workflow: Workflow | null;
  let listener: Listener | undefined;
  if (test) {
    listener = listeners().get(`${entry.account}/${entry.workflowId}`);
    if (!listener || listener.expires < Date.now()) {
      return jsonAnswer(404, { error: "not_listening", message: "Test URLs work while the editor is listening for a test call (press Listen in the Webhook node)." });
    }
    workflow = listener.workflow;
  } else {
    if (!entry.active) return jsonAnswer(404, { error: "not_active", message: "The workflow is not active (use the test URL while editing, or activate it)." });
    workflow = getWorkflow(entry.account, entry.workflowId);
  }
  if (!workflow) return notFound();
  const method = request.method.toUpperCase();
  const hooks = workflow.nodes.filter((node) => !node.disabled && nodeMeta(node.type)?.trigger === "webhook");
  let matched: { node: WorkflowNode; params: Record<string, string> } | null = null;
  let otherMethod = false;
  for (const node of hooks) {
    const params = matchHookPath(String(node.parameters.path ?? ""), path);
    if (!params) continue;
    const wanted = String(node.parameters.httpMethod ?? "POST").toUpperCase();
    if (wanted === method || (method === "HEAD" && wanted === "GET")) {
      matched = { node, params };
      break;
    }
    otherMethod = true;
  }
  if (!matched) return otherMethod ? jsonAnswer(405, { error: "method_not_allowed" }) : notFound();
  const limits = [LIMITS.hookWorkflow(`${entry.account}/${entry.workflowId}`), ...(test ? [] : [LIMITS.workflowRuns(entry.account)])];
  const byWorkflow = consumeLimits(limits);
  if (!byWorkflow.ok) return jsonAnswer(429, { error: "rate_limited" }, { "retry-after": String(byWorkflow.retryAfterSeconds) });
  const denied = checkAuth(entry.account, matched.node, request);
  if (denied) return denied;
  const url = new URL(request.url);
  const built = await requestItem(request, url, matched.params, Boolean(matched.node.parameters.rawBody));
  if (built instanceof Response) return built;
  if (test) {
    listeners().delete(`${entry.account}/${entry.workflowId}`);
  }

  const mode = String(matched.node.parameters.responseMode ?? "onReceived");
  const code = Math.max(100, Math.min(599, Math.floor(Number(matched.node.parameters.responseCode) || 200)));
  let responded: ((response: HookResponse) => void) | null = null;
  const respondedPromise = new Promise<HookResponse>((resolve) => {
    responded = resolve;
  });
  const run = startRun({
    accountId: entry.account,
    workflow,
    mode: test ? "webhook-test" : "webhook",
    startNode: matched.node.name,
    triggerItems: [built.item],
    triggerBlobs: built.blobs,
    progress: test,
    onRunId: (runId) => listener?.resolve(runId),
    onRespond: (response) => responded?.(response),
  });
  if (mode === "onReceived") {
    void run.catch((error: unknown) => console.error(`[workflows] webhook run failed to start: ${error instanceof Error ? error.message : String(error)}`));
    return jsonAnswer(code, { message: "Workflow was started" });
  }
  if (mode === "responseNode") {
    const first = await Promise.race([respondedPromise, run.then(() => null, () => null)]);
    if (first) return answer(first);
    return jsonAnswer(500, { error: "no_response", message: "The workflow finished without reaching a Respond to Webhook node." });
  }
  try {
    const { result } = await run;
    if (result.status !== "success" && result.status !== "waiting") return jsonAnswer(500, { error: "workflow_failed", message: "The workflow run failed." });
    const items = result.lastItems ?? [];
    const data = String(matched.node.parameters.responseData ?? "firstEntryJson");
    if (data === "noData") return answer({ status: code, headers: {} });
    return jsonAnswer(code, data === "allEntries" ? items.map((item) => item.json) : (items[0]?.json ?? {}));
  } catch {
    return jsonAnswer(503, { error: "busy", message: "The workflow could not start; try again shortly." });
  }
}

/** `/api/hooks/resume/<token>`: continues a run waiting in a Wait node set to "on webhook call". */
export async function handleResume(request: Request, token: string): Promise<Response> {
  const ip = clientIp(request);
  const byIp = consumeLimits([LIMITS.hookIp(ip)]);
  if (!byIp.ok) return jsonAnswer(429, { error: "rate_limited" }, { "retry-after": String(byIp.retryAfterSeconds) });
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return notFound();
  const wait = findWaitByResumeHash(tokenHash(token));
  if (!wait) return jsonAnswer(404, { error: "not_waiting", message: "No run waits for this address (it already resumed, expired or was deleted)." });
  const workflow = getWorkflow(wait.account, wait.workflowId);
  const record = workflow ? getRun(wait.account, wait.workflowId, wait.runId) : null;
  if (!workflow || !record || record.status !== "waiting") return notFound();
  const built = await requestItem(request, new URL(request.url), {}, false);
  if (built instanceof Response) return built;
  void startRun({ accountId: wait.account, workflow, mode: "resume", resume: { record, items: [built.item] }, triggerBlobs: built.blobs }).catch((error: unknown) =>
    console.error(`[workflows] resume failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  return jsonAnswer(200, { message: "Workflow was resumed" });
}

export function hookUrls(workflow: Workflow): { production: string; test: string } {
  const base = appBaseUrl();
  return { production: `${base}/api/hooks/${workflow.hookToken}`, test: `${base}/api/hooks-test/${workflow.hookToken}` };
}
