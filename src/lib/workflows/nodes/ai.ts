/**
 * AI nodes (metadata: src/lib/workflows/catalog/ai.ts): OpenAI-compatible chat completions through the run's
 * policy-checked HTTP client. The model comes from the node's `provider` credential slot, which the server fills with
 * the chosen provider profile or the node's AI provider credential (src/lib/workflows/server/runner.ts). Tool calls of
 * the agent run inside the worker: HTTP requests to the author's URL templates (the model fills placeholders, never the
 * host), sandboxed JavaScript, sub-workflows of the same account, a calculator, the clock.
 */
import { NodeError, type CredentialData, type ExecuteContext, type NodeImpl } from "../engine/node-api";
import { SandboxError } from "../sandbox/quickjs";
import type { Item, JsonObject } from "../types";
import { checkHeader } from "./auth";
import { isPlainObject, jsonParam, setPath } from "./util";

/** Model rounds one run may make (every AI node and agent step together): a looping agent stops here. */
const MAX_ROUNDS_PER_RUN = 200;
const rounds = new WeakMap<object, number>();

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  headers: Record<string, string>;
  reasoningEffort?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JsonObject };
}

async function providerOf(ctx: ExecuteContext): Promise<Provider> {
  let credential: CredentialData;
  try {
    credential = await ctx.credential("provider");
  } catch {
    throw new NodeError(
      ctx.rawParam("source") === "credential" ? "Choose an AI provider credential for this node." : "No AI provider profile is set up for this account.",
      { description: "Add a provider in the assistant's settings (it becomes a profile), or switch the node to an AI provider credential." },
    );
  }
  const data = credential.data;
  const baseUrl = String(data.baseUrl ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new NodeError("The AI provider has no valid base URL.");
  const headers: Record<string, string> = {};
  const extra = typeof data.extraHeaders === "string" ? (data.extraHeaders.trim() ? jsonParam(data.extraHeaders, "Extra headers") : {}) : data.extraHeaders;
  if (isPlainObject(extra)) {
    for (const [name, value] of Object.entries(extra)) {
      checkHeader(name, String(value));
      headers[name] = String(value);
    }
  }
  const override = String(ctx.param("model") ?? "").trim();
  const model = override || String(data.model ?? "");
  if (!model) throw new NodeError("The AI provider has no model; set one on the node.");
  return { name: credential.name, baseUrl, apiKey: String(data.apiKey ?? ""), model, headers, ...(typeof data.reasoningEffort === "string" && data.reasoningEffort ? { reasoningEffort: data.reasoningEffort } : {}) };
}

/** Anthropic's API wants `anthropic-version` and `x-api-key` (same rule as the assistant's provider path). */
function isAnthropicHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

function upstreamError(status: number, text: string, provider: Provider): NodeError {
  let detail = text.slice(0, 400);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed.error;
    const message = isPlainObject(error) ? error.message : typeof error === "string" ? error : parsed.message;
    if (typeof message === "string") detail = message;
  } catch {
    // not JSON
  }
  if (provider.apiKey) detail = detail.split(provider.apiKey).join("…");
  return new NodeError(`The model (${provider.model}) answered HTTP ${status}.`, { httpCode: status, description: detail.slice(0, 400) || undefined });
}

async function chat(ctx: ExecuteContext, provider: Provider, messages: ChatMessage[], options: { tools?: ToolDef[]; temperature?: number; json?: boolean } = {}): Promise<ChatMessage> {
  // Counted per run (the run's services object), not per process: in-process tests run many workflows.
  const used = (rounds.get(ctx.services) ?? 0) + 1;
  rounds.set(ctx.services, used);
  if (used > MAX_ROUNDS_PER_RUN) throw new NodeError(`The run made more than ${MAX_ROUNDS_PER_RUN} model calls (a looping agent?).`);
  const anthropic = isAnthropicHost(provider.baseUrl);
  const payload: Record<string, unknown> = { model: provider.model, messages, stream: false };
  // Newer Claude models reject temperature on Anthropic's OpenAI-compatible endpoint (src/lib/accounts/provider.ts).
  if (!anthropic && options.temperature !== undefined && Number.isFinite(options.temperature)) payload.temperature = options.temperature;
  if (options.tools?.length) payload.tools = options.tools;
  if (provider.reasoningEffort) payload.reasoning_effort = provider.reasoningEffort;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(anthropic ? { "anthropic-version": "2023-06-01", ...(provider.apiKey ? { "x-api-key": provider.apiKey } : {}) } : {}),
    ...provider.headers,
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const started = Date.now();
  let failed = true;
  let usage: Record<string, unknown> | undefined;
  try {
    const response = await ctx.services.http({ url: `${provider.baseUrl}/chat/completions`, method: "POST", headers, body: JSON.stringify(payload), followRedirects: false, timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 });
    const text = new TextDecoder().decode(response.body);
    if (response.status < 200 || response.status >= 300) throw upstreamError(response.status, text, provider);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new NodeError("The model's answer was not JSON (is the base URL an OpenAI-compatible endpoint ending in /v1?).");
    }
    const choice = Array.isArray(body.choices) && isPlainObject(body.choices[0]) ? body.choices[0] : null;
    const message = choice && isPlainObject(choice.message) ? choice.message : null;
    if (!message) throw new NodeError("The model's answer had no message (not an OpenAI chat completion).");
    usage = isPlainObject(body.usage) ? body.usage : undefined;
    failed = false;
    return {
      role: "assistant",
      content: typeof message.content === "string" ? message.content : null,
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length ? { tool_calls: message.tool_calls as ChatMessage["tool_calls"] } : {}),
    };
  } finally {
    ctx.services.reportUsage?.({ model: provider.model, usage, ms: Date.now() - started, failed });
  }
}

/** The first JSON value in a model's text (code fences and prose around it allowed). */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    const start = candidate.search(/[[{]/);
    if (start < 0) throw new NodeError("The model did not answer with JSON.");
    const open = candidate[start];
    const close = open === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(close);
    if (end <= start) throw new NodeError("The model did not answer with JSON.");
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown;
    } catch {
      throw new NodeError("The model's JSON could not be read.", { description: candidate.slice(0, 300) });
    }
  }
}

/** Asks for JSON and retries once with the parse error when the answer is not JSON. */
async function chatJson(ctx: ExecuteContext, provider: Provider, messages: ChatMessage[], temperature?: number): Promise<unknown> {
  const first = await chat(ctx, provider, messages, { temperature, json: true });
  try {
    return parseModelJson(first.content ?? "");
  } catch (error) {
    const retry = await chat(ctx, provider, [...messages, first, { role: "user", content: `That was not valid JSON (${error instanceof Error ? error.message : "parse error"}). Answer again with only the JSON, no prose.` }], { temperature: 0 });
    return parseModelJson(retry.content ?? "");
  }
}

function jsonInstruction(example: unknown): string {
  const shape = typeof example === "string" ? example : JSON.stringify(example, null, 2);
  return `\n\nAnswer with only a JSON value of this shape (no prose, no code fence):\n${shape}`;
}

/* ------------------------------------------------------------------------------------------------------ tools */

interface ToolSpec {
  kind: string;
  name: string;
  description: string;
  method?: string;
  url?: string;
  code?: string;
  workflowId?: string;
  inputSchema?: unknown;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function toolSpecs(ctx: ExecuteContext): ToolSpec[] {
  const rows = ctx.rawParam("tools");
  if (!Array.isArray(rows)) return [];
  const specs: ToolSpec[] = [];
  const names = new Set<string>();
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    const kind = String(row.kind ?? "httpRequest");
    const name = String(row.name ?? "").trim() || kind;
    if (!TOOL_NAME.test(name)) throw new NodeError(`Tool name "${name}" may only hold letters, digits, _ and - (64 at most).`);
    if (names.has(name)) throw new NodeError(`Two tools are named "${name}".`);
    names.add(name);
    const schemaText = typeof row.inputSchema === "string" ? row.inputSchema.trim() : row.inputSchema;
    const inputSchema = schemaText ? jsonParam(schemaText, `The arguments schema of tool ${name}`) : undefined;
    if (kind === "httpRequest") {
      const url = String(row.url ?? "");
      const origin = /^(https?:\/\/[^/?#]*)/i.exec(url)?.[1] ?? "";
      if (!origin || origin.includes("{")) throw new NodeError(`Tool ${name}: the URL must start with a fixed http(s)://host (placeholders only after the host).`);
    }
    specs.push({ kind, name, description: String(row.description ?? "").trim() || `${kind} tool`, method: String(row.method ?? "GET").toUpperCase(), url: String(row.url ?? ""), code: String(row.code ?? ""), workflowId: String(row.workflowId ?? ""), inputSchema });
  }
  return specs;
}

function placeholders(url: string): string[] {
  return [...new Set([...url.matchAll(/\{([A-Za-z_][\w]*)\}/g)].map((m) => m[1]))];
}

function toolDef(spec: ToolSpec): ToolDef {
  let parameters: JsonObject;
  if (isPlainObject(spec.inputSchema)) parameters = spec.inputSchema;
  else if (spec.kind === "httpRequest") {
    const names = placeholders(spec.url ?? "");
    const withBody = ["POST", "PUT", "PATCH"].includes(spec.method ?? "GET");
    parameters = {
      type: "object",
      properties: { ...Object.fromEntries(names.map((n) => [n, { type: "string" }])), ...(withBody ? { body: { type: "object", description: "JSON body of the request" } } : {}) },
      required: names,
    };
  } else if (spec.kind === "calculator") parameters = { type: "object", properties: { expression: { type: "string", description: "A math expression, e.g. (17.5 * 3) / 4 or sqrt(2)" } }, required: ["expression"] };
  else if (spec.kind === "dateTime") parameters = { type: "object", properties: {} };
  else parameters = { type: "object", properties: { input: { type: "string", description: "What to pass to the tool" } }, required: ["input"] };
  return { type: "function", function: { name: spec.name, description: spec.description, parameters } };
}

const clip = (text: string, max = 20_000) => (text.length > max ? `${text.slice(0, max)}… (cut at ${max} characters)` : text);

async function runTool(ctx: ExecuteContext, spec: ToolSpec, args: JsonObject): Promise<string> {
  switch (spec.kind) {
    case "httpRequest": {
      const url = (spec.url ?? "").replace(/\{([A-Za-z_][\w]*)\}/g, (_match, key: string) => encodeURIComponent(String(args[key] ?? "")));
      const withBody = ["POST", "PUT", "PATCH"].includes(spec.method ?? "GET");
      const response = await ctx.services.http({
        url,
        method: spec.method ?? "GET",
        headers: { accept: "application/json, text/plain, */*", ...(withBody ? { "content-type": "application/json" } : {}) },
        body: withBody ? JSON.stringify(args.body ?? {}) : undefined,
        timeoutMs: 30_000,
        maxBytes: 2 * 1024 * 1024,
      });
      return clip(`HTTP ${response.status}\n${new TextDecoder().decode(response.body)}`);
    }
    case "code": {
      const box = await ctx.openSandbox({ timeoutMs: 10_000 });
      try {
        box.setJson("input", "input" in args && Object.keys(args).length === 1 ? args.input : args);
        const result = box.run(`(async () => {\n${spec.code ?? ""}\n})()`);
        for (const line of box.logs) ctx.log(`[${spec.name}] ${line}`);
        return clip(typeof result === "string" ? result : JSON.stringify(result ?? null));
      } catch (error) {
        return `Error: ${error instanceof SandboxError ? error.message : String(error)}`;
      } finally {
        box.dispose();
      }
    }
    case "workflow": {
      if (!ctx.services.callWorkflow) return "Error: sub-workflows are not available.";
      const items = await ctx.services.callWorkflow({ workflowId: spec.workflowId ?? "", items: [{ json: args }], wait: true });
      return clip(JSON.stringify(items.slice(0, 50).map((item) => item.json)));
    }
    case "calculator": {
      const expression = String(args.expression ?? "");
      if (!/^[\d\s+\-*/%^().,a-z_]*$/i.test(expression)) return "Error: only numbers, operators and Math functions are allowed.";
      const box = await ctx.openSandbox({ timeoutMs: 1_000 });
      try {
        box.setJson("__e", expression.replace(/\^/g, "**"));
        return String(box.run("(() => { const { abs, ceil, floor, round, sqrt, cbrt, pow, min, max, log, log10, log2, exp, sin, cos, tan, asin, acos, atan, atan2, PI, E } = Math; const pi = PI, e = E; return eval(__e); })()"));
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        box.dispose();
      }
    }
    case "dateTime": {
      const now = new Date(ctx.now() + ctx.tzOffsetMinutes * 60_000);
      return `${now.toISOString().slice(0, 19)} (${ctx.timezone}, UTC${ctx.tzOffsetMinutes >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(ctx.tzOffsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(ctx.tzOffsetMinutes) % 60).padStart(2, "0")})`;
    }
    default:
      return `Error: unknown tool kind ${spec.kind}.`;
  }
}

/* ------------------------------------------------------------------------------------------------------ nodes */

function outputValue(ctx: ExecuteContext, index: number, text: string, json: unknown): JsonObject {
  if (ctx.param("outputFormat", index) === "json") return isPlainObject(json) ? json : { output: json };
  return { output: text };
}

const agentNode: NodeImpl = {
  type: "core.ai-agent",
  async execute(ctx) {
    const provider = await providerOf(ctx);
    const specs = toolSpecs(ctx);
    const defs = specs.map(toolDef);
    const maxIterations = Math.max(1, Math.min(30, Math.floor(Number(ctx.param("maxIterations")) || 8)));
    const out: Item[] = [];
    for (let index = 0; index < ctx.items.length; index += 1) {
      const item = ctx.items[index];
      const json = ctx.param("outputFormat", index) === "json";
      const system = `${String(ctx.param("instructions", index) ?? "")}${json ? jsonInstruction(ctx.param("jsonExample", index)) : ""}`;
      const prompt = String(ctx.param("prompt", index) ?? "");
      const memoryOn = ctx.param("memory", index) === "session";
      const sessionKey = memoryOn ? String(ctx.param("sessionKey", index) ?? "default").slice(0, 200) : "";
      const window = Math.max(2, Math.min(100, Math.floor(Number(ctx.param("memoryWindow", index)) || 10)));
      const memory = (ctx.staticData.memory ??= {}) as Record<string, ChatMessage[]>;
      const history = memoryOn ? memory[sessionKey] ?? [] : [];
      const messages: ChatMessage[] = [...(system.trim() ? [{ role: "system" as const, content: system }] : []), ...history, { role: "user", content: prompt }];
      const steps: JsonObject[] = [];
      let final: string | null = null;
      for (let round = 0; round < maxIterations + 1; round += 1) {
        const answer = await chat(ctx, provider, messages, { tools: round < maxIterations ? defs : undefined, temperature: Number(ctx.param("temperature", index)) });
        if (!answer.tool_calls?.length) {
          final = answer.content ?? "";
          break;
        }
        messages.push(answer);
        for (const call of answer.tool_calls) {
          const spec = specs.find((entry) => entry.name === call.function?.name);
          let args: JsonObject = {};
          try {
            const parsed = JSON.parse(call.function?.arguments || "{}") as unknown;
            if (isPlainObject(parsed)) args = parsed;
          } catch {
            args = {};
          }
          let result: string;
          try {
            result = spec ? await runTool(ctx, spec, args) : `Error: there is no tool named ${call.function?.name}.`;
          } catch (error) {
            result = `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
          steps.push({ tool: call.function?.name ?? "?", input: args, output: result.slice(0, 2000) });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }
      if (final === null) throw new NodeError(`The agent did not finish within ${maxIterations} tool rounds.`, { itemIndex: index });
      if (memoryOn) {
        const turn: ChatMessage[] = [{ role: "user", content: prompt }, { role: "assistant", content: final }];
        memory[sessionKey] = [...history, ...turn].slice(-window);
        const keys = Object.keys(memory);
        if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete memory[key];
      }
      const parsed = json ? parseModelJson(final) : undefined;
      out.push({ json: { ...outputValue(ctx, index, final, parsed), ...(steps.length ? { steps } : {}) }, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index });
    }
    return [out];
  },
};

const chatNode: NodeImpl = {
  type: "core.ai-chat",
  async execute(ctx) {
    const provider = await providerOf(ctx);
    const out: Item[] = [];
    for (let index = 0; index < ctx.items.length; index += 1) {
      const item = ctx.items[index];
      const json = ctx.param("outputFormat", index) === "json";
      const instructions = String(ctx.param("instructions", index) ?? "");
      const system = `${instructions}${json ? jsonInstruction(ctx.param("jsonExample", index)) : ""}`.trim();
      const messages: ChatMessage[] = [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: String(ctx.param("prompt", index) ?? "") }];
      const temperature = Number(ctx.param("temperature", index));
      const result = { ...item.json };
      if (json) {
        const value = await chatJson(ctx, provider, messages, temperature);
        Object.assign(result, isPlainObject(value) ? value : { output: value });
      } else {
        const answer = await chat(ctx, provider, messages, { temperature });
        setPath(result, String(ctx.param("outputField", index) || "text"), answer.content ?? "");
      }
      out.push({ json: result, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index });
    }
    return [out];
  },
};

function coerceField(value: unknown, type: string): unknown {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[^\d.,-]/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return typeof value === "boolean" ? value : /^(true|yes|1)$/i.test(String(value));
    case "date": {
      const text = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
      // A date without a zone parses as local midnight: read it back in local time, or the day can shift.
      const parsed = new Date(text);
      if (!Number.isFinite(parsed.getTime())) return text;
      return `${String(parsed.getFullYear()).padStart(4, "0")}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }
    case "array":
      return Array.isArray(value) ? value : [value];
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

const extractNode: NodeImpl = {
  type: "core.ai-extract",
  async execute(ctx) {
    const provider = await providerOf(ctx);
    const out: Item[] = [];
    for (let index = 0; index < ctx.items.length; index += 1) {
      const fields = (ctx.param<{ name?: string; type?: string; description?: string; required?: boolean }[]>("attributes", index) ?? []).filter((f) => String(f.name ?? "").trim());
      if (!fields.length) throw new NodeError("Name at least one field to extract.");
      const list = fields.map((f) => `- "${f.name}" (${f.type ?? "string"}${f.required ? ", required" : ""}): ${f.description ?? ""}`).join("\n");
      const system = `You extract information from text. Answer with only a JSON object with exactly these keys:\n${list}\nUse null when the text does not contain a value; never guess or invent one. Dates as YYYY-MM-DD.${ctx.param("instructions", index) ? `\n${String(ctx.param("instructions", index))}` : ""}`;
      const value = await chatJson(ctx, provider, [{ role: "system", content: system }, { role: "user", content: String(ctx.param("text", index) ?? "") }], 0);
      const record = isPlainObject(value) ? value : {};
      const json: JsonObject = {};
      for (const field of fields) json[String(field.name)] = coerceField(record[String(field.name)], field.type ?? "string");
      out.push({ json, pairedItem: index });
    }
    return [out];
  },
};

const classifyNode: NodeImpl = {
  type: "core.ai-classify",
  async execute(ctx) {
    const provider = await providerOf(ctx);
    const categories = (ctx.param<{ name?: string; description?: string }[]>("categories") ?? []).map((c, i) => ({ name: String(c.name ?? "").trim() || `Category ${i + 1}`, description: String(c.description ?? "") }));
    if (!categories.length) throw new NodeError("Add at least one category.");
    const multiple = ctx.param<boolean>("multiple");
    const other = ctx.param("fallback") === "other";
    const outputs: Item[][] = Array.from({ length: categories.length + (other ? 1 : 0) }, () => []);
    const list = categories.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""}`).join("\n");
    const system = `Classify the text into ${multiple ? "one or more" : "exactly one"} of these categories:\n${list}\nIf none fits, answer with an empty list. Answer with only JSON: {"categories": ["<name>"]}.`;
    for (let index = 0; index < ctx.items.length; index += 1) {
      const value = await chatJson(ctx, provider, [{ role: "system", content: system }, { role: "user", content: String(ctx.param("text", index) ?? "") }], 0);
      const chosen = isPlainObject(value) && Array.isArray(value.categories) ? value.categories.map((v) => String(v).trim().toLowerCase()) : [];
      let matched = false;
      categories.forEach((category, at) => {
        if (chosen.includes(category.name.toLowerCase()) && (multiple || !matched)) {
          outputs[at].push({ ...ctx.items[index], pairedItem: index });
          matched = true;
        }
      });
      if (!matched && other) outputs[outputs.length - 1].push({ ...ctx.items[index], pairedItem: index });
    }
    return outputs;
  },
};

export const AI_IMPLS: NodeImpl[] = [agentNode, chatNode, extractNode, classifyNode];
