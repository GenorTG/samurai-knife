/** Fixed-host service operations, with all IO through the worker's authorized, policy-checked transport. */
import { NodeError, type ExecuteContext, type HttpRequest, type HttpResponse, type NodeImpl } from "../engine/node-api";
import { INTEGRATIONS } from "../integrations/index";
import type { IntegrationField, IntegrationOperation, IntegrationSpec } from "../integrations/types";
import type { Item } from "../types";
import { sendAuthorized } from "./auth";
import { getPath, isPlainObject, jsonParam, setPath } from "./util";

interface RequestPlan {
  operation: IntegrationOperation;
  request: HttpRequest;
  body: Record<string, unknown>;
  limit: number;
  maxPages: number;
  index: number;
}

function integer(value: unknown, label: string, max: number): number {
  const number = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > max) throw new NodeError(`${label} must be an integer between 1 and ${max}.`);
  return number;
}

function checkedField(field: IntegrationField, raw: unknown): unknown {
  const p = field.parameter;
  const fail = (detail: string): never => { throw new NodeError(`${p.label}: ${detail}.`); };
  if (raw === undefined || raw === null || raw === "") {
    if (p.required) fail("a value is required");
    return undefined;
  }
  let value = p.type === "json" ? jsonParam(raw, p.label) : raw;
  if (p.type === "string" || p.type === "options") {
    if (typeof value !== "string" && typeof value !== "number") fail("use text or an ID");
    value = String(value);
    if (p.required && !(value as string).trim()) fail("a value is required");
    if (p.max !== undefined && (value as string).length > p.max) fail(`use at most ${p.max} characters`);
    if (p.options && !p.options.some((option) => option.value === value)) fail("choose a supported option");
  }
  if (field.location === "path") {
    if (typeof value !== "string" || value === "." || value === ".." || /[\0-\x1f\x7f]/.test(value)) fail("invalid path identifier");
  }
  switch (field.validate) {
    case "object":
      if (!isPlainObject(value)) fail("use a JSON object");
      break;
    case "properties": {
      const properties = isPlainObject(value) ? value : {};
      if (!isPlainObject(value) || !Object.values(properties).every((v) => typeof v === "string") || !["email", "firstname", "lastname"].some((key) => typeof properties[key] === "string" && (properties[key] as string).trim())) fail("use string-valued CRM properties including email, firstname or lastname");
      break;
    }
    case "matrix":
      if (!Array.isArray(value) || !value.length || value.length > 1000 || !value.every((row) => Array.isArray(row) && row.length > 0 && row.every((cell) => cell === null || typeof cell === "string" || typeof cell === "boolean" || typeof cell === "number" && Number.isFinite(cell)))) fail("use 1–1000 rows of scalar JSON cell values");
      break;
    case "blocks":
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || !value.every((block) => isPlainObject(block) && typeof block.type === "string" && isPlainObject(block[block.type]))) fail("use 1–100 typed Notion block objects");
      break;
    case "instant":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail("use an RFC3339 timestamp with timezone offset");
      break;
    case "recipients": {
      const recipients = String(value).split(",").map((email) => email.trim());
      if (!recipients.length || recipients.length > 100 || recipients.some((email) => !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email))) fail("use up to 100 comma-separated email addresses");
      value = recipients;
      break;
    }
  }
  if (field.transform === "recipients") value = (value as string[]).map((address) => ({ emailAddress: { address } }));
  if (field.transform === "array") value = [value];
  return value;
}

/** RFC3986 segments, including A1 ranges, GitLab namespaced projects and Graph channel IDs. Never resolve an ID as a URL. */
function segment(value: unknown): string {
  try {
    return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    throw new NodeError("A path identifier contains invalid Unicode.");
  }
}

function prepare(ctx: ExecuteContext, spec: IntegrationSpec, index: number): RequestPlan {
  const operation = spec.operations.find((op) => op.id === ctx.param("operation", index));
  if (!operation) throw new NodeError(`Choose a supported ${spec.label} operation.`, { itemIndex: index });
  const pathValues = new Map<string, unknown>();
  const query = new URLSearchParams(operation.query);
  const body: Record<string, unknown> = structuredClone(operation.body ?? {});
  const values = new Map<string, unknown>();
  for (const field of operation.fields) {
    const value = checkedField(field, ctx.param(field.parameter.name, index));
    values.set(field.parameter.name, value);
    if (value === undefined) continue;
    if (field.location === "path") pathValues.set(field.target, value);
    if (field.location === "query") query.set(field.target, String(value));
    if (field.location === "body") setPath(body, field.target, value);
  }
  if (operation.timeOrder) {
    const [start, end] = operation.timeOrder.map((name) => values.get(name));
    if (start && end && Date.parse(String(end)) <= Date.parse(String(start))) throw new NodeError("The end of the time range must be after its start.", { itemIndex: index });
  }
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    if (!pathValues.has(name)) throw new NodeError(`Missing path parameter ${name}.`);
    return segment(pathValues.get(name));
  });
  const url = new URL(`${spec.baseUrl}${path}`);
  url.search = query.toString();
  // Defence in depth: contracts are source-owned, never merge URL/host/header overrides from workflow parameters.
  if (url.origin !== new URL(spec.baseUrl).origin || url.username || url.password) throw new NodeError("Integration host overrides are not allowed.");
  const hasBody = operation.method !== "GET";
  const request: HttpRequest = {
    url: url.toString(), method: operation.method,
    headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...spec.headers },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
    followRedirects: false, maxRedirects: 0, timeoutMs: 30_000, maxBytes: ctx.limits.maxHttpBytes,
  };
  return { operation, request, body, index, limit: operation.pagination ? integer(ctx.param("limit", index), "Maximum results", 1000) : 1, maxPages: operation.pagination ? integer(ctx.param("maxPages", index), "Maximum pages", 10) : 1 };
}

function responseBody(spec: IntegrationSpec, response: HttpResponse): unknown {
  if (response.status >= 300 && response.status < 400) throw new NodeError(`${spec.label} returned a redirect; integration redirects are refused.`, { httpCode: response.status });
  const text = new TextDecoder().decode(response.body);
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : { accepted: true, statusCode: response.status };
  } catch {
    throw new NodeError(`${spec.label} returned invalid JSON (HTTP ${response.status}).`, { httpCode: response.status });
  }
  const envelope = isPlainObject(value) ? value : {};
  const failed = response.status < 200 || response.status >= 400 || spec.envelope === "slack" && envelope.ok !== true || envelope.object === "error" || envelope.status === "error" || envelope.error !== undefined && envelope.error !== null;
  if (failed) {
    const error = envelope.error;
    const detail = isPlainObject(error) ? error.message ?? error.type ?? error.code : error;
    const message = detail ?? envelope.message ?? envelope.error_description ?? "Request failed";
    throw new NodeError(`${spec.label} request failed (HTTP ${response.status}).`, { description: String(message).slice(0, 500), httpCode: response.status });
  }
  return value;
}

function results(operation: IntegrationOperation, value: unknown): unknown[] {
  const collection = operation.output ? getPath(value, operation.output) : value;
  if (operation.output && collection === undefined && operation.optionalOutput) return [];
  if (operation.output && !Array.isArray(collection)) throw new NodeError(`The service response is missing the ${operation.output} collection.`);
  if (operation.pagination && !Array.isArray(collection)) throw new NodeError("The service did not return a result collection.");
  return Array.isArray(collection) ? collection : [collection];
}

/** Validate Graph's next link, then extract only paging tokens into the original fixed-host request. */
function graphCursor(value: unknown, original: string): Record<string, string> | null {
  const nextLink = getPath(value, "@odata.nextLink");
  if (!nextLink) return null;
  let next: URL;
  try { next = new URL(String(nextLink)); } catch { throw new NodeError("Microsoft Graph returned an invalid pagination URL."); }
  const expected = new URL(original);
  if (next.origin !== expected.origin || next.pathname !== expected.pathname || next.username || next.password || next.hash) throw new NodeError("Microsoft Graph returned an unsafe pagination URL.");
  const tokens: Record<string, string> = {};
  for (const key of ["$skip", "$skiptoken"]) {
    const token = next.searchParams.get(key);
    if (token) tokens[key] = token;
  }
  if (!Object.keys(tokens).length) throw new NodeError("Microsoft Graph pagination did not include a supported skip token.");
  return tokens;
}

async function execute(ctx: ExecuteContext, spec: IntegrationSpec): Promise<Item[][]> {
  for (const key of ["url", "baseUrl", "baseURL", "host", "endpoint", "apiUrl"]) if (ctx.rawParam(key) !== undefined) throw new NodeError("Integration URL/host overrides are not allowed.");
  // Preflight every input before any writes: an invalid later item must not leave earlier inputs partly committed.
  const plans = ctx.items.map((_, index) => prepare(ctx, spec, index));
  ctx.signal.throwIfAborted();
  const credential = await ctx.credential("auth");
  if (!spec.credentialTypes.includes(credential.type)) throw new NodeError(`This credential type cannot be used with ${spec.label}.`);
  const out: Item[] = [];
  for (const plan of plans) {
    const pagination = plan.operation.pagination;
    let cursor: Record<string, string> = {};
    const seen = new Set<string>();
    let emitted = 0;
    for (let page = 1; page <= plan.maxPages; page += 1) {
      ctx.signal.throwIfAborted();
      const size = Math.min(plan.limit - emitted, pagination?.maxPageSize ?? 1);
      const build = (): HttpRequest => {
        ctx.signal.throwIfAborted();
        const url = new URL(plan.request.url);
        const body = structuredClone(plan.body);
        if (pagination) {
          const params: Record<string, string> = { [pagination.limitKey]: String(size), ...cursor, ...(pagination.mode === "page" ? { page: String(page) } : {}) };
          for (const [key, value] of Object.entries(params)) {
            if (pagination.location === "body") body[key] = key === pagination.limitKey ? Number(value) : value;
            else url.searchParams.set(key, value);
          }
        }
        return { ...plan.request, url: url.toString(), headers: { ...plan.request.headers }, ...(plan.operation.method !== "GET" ? { body: JSON.stringify(body) } : {}) };
      };
      const response = await sendAuthorized(ctx, build, credential);
      ctx.signal.throwIfAborted();
      const value = responseBody(spec, response);
      const rows = results(plan.operation, value);
      for (const row of pagination ? rows.slice(0, plan.limit - emitted) : rows) {
        if (out.length >= ctx.limits.maxItemsPerOutput) throw new NodeError("Integration results exceed the run's item limit.");
        out.push({ json: isPlainObject(row) ? row : { value: row }, pairedItem: plan.index });
        emitted += 1;
      }
      if (!pagination || emitted >= plan.limit || page >= plan.maxPages) break;
      if (pagination.mode === "page") {
        if (rows.length < size) break;
        continue;
      }
      if (pagination.mode === "graph") {
        const next = graphCursor(value, plan.request.url);
        if (!next) break;
        cursor = next;
      } else {
        const token = pagination.mode === "before" ? getPath(rows.at(-1), "id") : getPath(value, pagination.cursorPath!);
        if (token === undefined || token === null || token === "") break;
        if (typeof token !== "string" && typeof token !== "number") throw new NodeError("The service returned an invalid pagination token.");
        cursor = { [pagination.cursorKey!]: String(token) };
      }
      const key = JSON.stringify(cursor);
      if (seen.has(key)) throw new NodeError("The service repeated a pagination token; stopping to avoid a loop.");
      seen.add(key);
    }
  }
  return [out];
}

export const INTEGRATION_IMPLS: NodeImpl[] = INTEGRATIONS.map((spec) => ({ type: spec.type, execute: (ctx) => execute(ctx, spec) }));
