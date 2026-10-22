/** Triggers and flow-control node implementations (metadata: src/lib/workflows/catalog/flow.ts). */
import { NodeError, type ExecuteContext, type NodeImpl, type NodeOutcome } from "../engine/node-api";
import type { HookResponse, Item, JsonObject } from "../types";
import { evaluateConditions, type ConditionOptions } from "./conditions";
import { getPath, isPlainObject, jsonParam, keyValues, stableKey } from "./util";

/** Every trigger outputs the items that started the run (built by the server: request, tick, caller's items). */
const passTrigger = (type: string): NodeImpl => ({
  type,
  async execute(ctx) {
    return [ctx.triggerItems];
  },
});

function conditionOptions(ctx: ExecuteContext, index: number): ConditionOptions {
  const options = ctx.param<Record<string, unknown>>("options", index) ?? {};
  return { ignoreCase: Boolean(options.ignoreCase), looseTypes: Boolean(options.looseTypes) };
}

const ifNode: NodeImpl = {
  type: "core.if",
  async execute(ctx) {
    const yes: Item[] = [];
    const no: Item[] = [];
    ctx.items.forEach((item, index) => {
      (evaluateConditions(ctx.param("conditions", index), conditionOptions(ctx, index)) ? yes : no).push({ ...item, pairedItem: index });
    });
    return [yes, no];
  },
};

const filterNode: NodeImpl = {
  type: "core.filter",
  async execute(ctx) {
    const kept: Item[] = [];
    const discarded: Item[] = [];
    ctx.items.forEach((item, index) => {
      (evaluateConditions(ctx.param("conditions", index), conditionOptions(ctx, index)) ? kept : discarded).push({ ...item, pairedItem: index });
    });
    return ctx.param<boolean>("discardedOutput") ? [kept, discarded] : [kept, []];
  },
};

const switchNode: NodeImpl = {
  type: "core.switch",
  async execute(ctx) {
    if (ctx.param("mode") === "expression") {
      const count = Math.max(1, Math.min(32, Number(ctx.param("numberOutputs")) || 4));
      const outputs: Item[][] = Array.from({ length: count }, () => []);
      ctx.items.forEach((item, index) => {
        const target = Number(ctx.param("output", index));
        if (!Number.isInteger(target) || target < 0 || target >= count) {
          throw new NodeError(`Output index ${JSON.stringify(target)} is not between 0 and ${count - 1}.`, { itemIndex: index });
        }
        outputs[target].push({ ...item, pairedItem: index });
      });
      return outputs;
    }
    const rawRules = ctx.rawParam("rules");
    const ruleCount = Array.isArray(rawRules) ? rawRules.length : 0;
    const options = ctx.param<Record<string, unknown>>("options") ?? {};
    const fallback = options.fallbackOutput === "extra";
    const outputs: Item[][] = Array.from({ length: Math.max(1, ruleCount) + (fallback ? 1 : 0) }, () => []);
    ctx.items.forEach((item, index) => {
      const rules = ctx.param<unknown[]>("rules", index) ?? [];
      const opts = ctx.param<Record<string, unknown>>("options", index) ?? {};
      const conditionOpts = { ignoreCase: Boolean(opts.ignoreCase), looseTypes: Boolean(opts.looseTypes) };
      let matched = false;
      for (let rule = 0; rule < rules.length; rule += 1) {
        const entry = rules[rule];
        if (!isPlainObject(entry) || !evaluateConditions(entry.conditions, conditionOpts)) continue;
        outputs[rule].push({ ...item, pairedItem: index });
        matched = true;
        if (!opts.allMatchingOutputs) break;
      }
      if (!matched && fallback) outputs[outputs.length - 1].push({ ...item, pairedItem: index });
    });
    return outputs;
  },
};

function mergeJson(a: JsonObject, b: JsonObject, prefer: "preferInput1" | "preferInput2"): JsonObject {
  return prefer === "preferInput1" ? { ...b, ...a } : { ...a, ...b };
}

const mergeNode: NodeImpl = {
  type: "core.merge",
  async execute(ctx) {
    const [one = [], two = []] = ctx.inputs;
    const mode = ctx.param<string>("mode");
    const clash = ctx.param<"preferInput1" | "preferInput2">("clash") ?? "preferInput2";
    if (mode === "append") return [[...one, ...two]];
    if (mode === "chooseBranch") {
      const output = ctx.param<string>("output");
      return [output === "input2" ? two : output === "empty" ? [{ json: {} }] : one];
    }
    if (mode === "combineByPosition") {
      const keep = ctx.param<boolean>("includeUnpaired");
      const length = keep ? Math.max(one.length, two.length) : Math.min(one.length, two.length);
      return [Array.from({ length }, (_, index) => ({ json: mergeJson(one[index]?.json ?? {}, two[index]?.json ?? {}, clash), binary: { ...one[index]?.binary, ...two[index]?.binary }, pairedItem: index }))];
    }
    if (mode === "combineAll") {
      if (one.length * two.length > ctx.limits.maxItemsPerOutput) throw new NodeError(`Every combination would make ${one.length * two.length} items (limit ${ctx.limits.maxItemsPerOutput}).`);
      return [one.flatMap((a, index) => two.map((b) => ({ json: mergeJson(a.json, b.json, clash), pairedItem: index })))];
    }
    if (mode === "combineByFields") {
      const fields = (ctx.param<{ field1?: string; field2?: string }[]>("fields") ?? []).filter((f) => f.field1 && f.field2);
      if (!fields.length) throw new NodeError("Add at least one pair of fields to match.");
      const keyOf = (item: Item, side: "field1" | "field2") => stableKey(fields.map((f) => getPath(item.json, f[side] as string)));
      const index2 = new Map<string, Item[]>();
      for (const item of two) {
        const key = keyOf(item, "field2");
        index2.set(key, [...(index2.get(key) ?? []), item]);
      }
      const matched2 = new Set<Item>();
      const out: Item[] = [];
      const joinMode = ctx.param<string>("joinMode");
      one.forEach((a, index) => {
        const matches = index2.get(keyOf(a, "field1")) ?? [];
        for (const b of matches) matched2.add(b);
        if (joinMode === "keepMatches" || joinMode === "keepEverything" || joinMode === "enrichInput1") {
          if (matches.length) for (const b of matches) out.push({ json: mergeJson(a.json, b.json, clash), pairedItem: index });
          else if (joinMode !== "keepMatches") out.push({ ...a, pairedItem: index });
        } else if (joinMode === "keepNonMatches" && !matches.length) {
          out.push({ ...a, pairedItem: index });
        }
      });
      if (joinMode === "keepNonMatches" || joinMode === "keepEverything") for (const b of two) if (!matched2.has(b)) out.push(b);
      if (joinMode === "enrichInput2") {
        const index1 = new Map<string, Item[]>();
        for (const a of one) {
          const key = keyOf(a, "field1");
          index1.set(key, [...(index1.get(key) ?? []), a]);
        }
        return [two.flatMap((b, index) => {
          const matches = index1.get(keyOf(b, "field2")) ?? [];
          return matches.length ? matches.map((a) => ({ json: mergeJson(a.json, b.json, clash), pairedItem: index })) : [{ ...b, pairedItem: index }];
        })];
      }
      return [out];
    }
    throw new NodeError(`Unknown merge mode "${mode}".`);
  },
};

/** Loop Over Items: the queue and the collected results live in the node's per-run state. */
const loopNode: NodeImpl = {
  type: "core.loop",
  async execute(ctx) {
    const size = Math.max(1, Math.floor(Number(ctx.param("batchSize")) || 1));
    const state = ctx.state as { queue?: Item[]; done?: Item[]; started?: boolean };
    if (!state.started || ctx.param<boolean>("reset")) {
      state.queue = [...ctx.items];
      state.done = [];
      state.started = true;
    } else {
      state.done = [...(state.done ?? []), ...ctx.items];
    }
    const queue = state.queue ?? [];
    if (queue.length) {
      const batch = queue.splice(0, size);
      return [[], batch];
    }
    const done = state.done ?? [];
    state.started = false;
    state.queue = [];
    state.done = [];
    return [done, []];
  },
};

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

const waitNode: NodeImpl = {
  type: "core.wait",
  async execute(ctx): Promise<NodeOutcome> {
    const resume = ctx.param<string>("resume");
    const now = ctx.now();
    if (resume === "timeInterval") {
      const ms = Math.max(0, Number(ctx.param("amount")) || 0) * (UNIT_MS[ctx.param<string>("unit")] ?? 1000);
      return { outputs: [ctx.items], wait: { until: now + ms } };
    }
    if (resume === "specificTime") {
      const when = Date.parse(String(ctx.param("dateTime") ?? ""));
      if (!Number.isFinite(when)) throw new NodeError("Set a valid date and time to wait for.");
      return { outputs: [ctx.items], wait: { until: Math.max(now, when) } };
    }
    if (resume === "webhook") {
      const limit = ctx.param<boolean>("limitWait") ? now + Math.max(1, Number(ctx.param("limitAmount")) || 24) * 3_600_000 : undefined;
      return { outputs: [ctx.items], wait: { webhook: true, until: limit } };
    }
    throw new NodeError(`Unknown resume mode "${resume}".`);
  },
};

const executeWorkflowNode: NodeImpl = {
  type: "core.execute-workflow",
  async execute(ctx) {
    const call = ctx.services.callWorkflow;
    if (!call) throw new NodeError("Sub-workflows are not available in this run.");
    const workflowId = String(ctx.param("workflowId") ?? "").trim();
    if (!workflowId) throw new NodeError("Choose the workflow to run.");
    if (workflowId === ctx.workflow.id) throw new NodeError("A workflow cannot call itself as a sub-workflow.");
    const wait = ctx.param<boolean>("waitForSubWorkflow") !== false;
    if (ctx.param("mode") === "each") {
      const out: Item[] = [];
      for (let index = 0; index < ctx.items.length; index += 1) {
        const result = await call({ workflowId, items: [ctx.items[index]], wait });
        out.push(...(wait ? result.map((item) => ({ ...item, pairedItem: index })) : [ctx.items[index]]));
      }
      return [out];
    }
    const result = await call({ workflowId, items: ctx.items, wait });
    return [wait ? result : ctx.items];
  },
};

const respondNode: NodeImpl = {
  type: "core.respond-to-webhook",
  async execute(ctx): Promise<NodeOutcome> {
    const how = ctx.param<string>("respondWith");
    const status = Math.max(100, Math.min(599, Math.floor(Number(ctx.param("responseCode")) || 200)));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(keyValues(ctx.param("headers")))) {
      if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name) && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
    }
    const response: HookResponse = { status, headers };
    const first = ctx.items[0];
    if (how === "firstIncomingItem") {
      response.body = JSON.stringify(first?.json ?? {});
      headers["content-type"] ??= "application/json; charset=utf-8";
    } else if (how === "allIncomingItems") {
      response.body = JSON.stringify(ctx.items.map((item) => item.json));
      headers["content-type"] ??= "application/json; charset=utf-8";
    } else if (how === "json") {
      response.body = JSON.stringify(jsonParam(ctx.param("responseBody"), "Response body"));
      headers["content-type"] ??= "application/json; charset=utf-8";
    } else if (how === "text") {
      response.body = String(ctx.param("responseText") ?? "");
      headers["content-type"] ??= "text/plain; charset=utf-8";
    } else if (how === "binary") {
      const property = String(ctx.param("binaryProperty") ?? "data");
      const ref = first?.binary?.[property];
      if (!ref) throw new NodeError(`The first item has no file in "${property}".`);
      response.bodyBase64 = Buffer.from(ctx.services.blobs.get(ref)).toString("base64");
      headers["content-type"] ??= ref.mimeType;
    } else if (how === "redirect") {
      const target = String(ctx.param("redirectUrl") ?? "");
      if (!/^https?:\/\//i.test(target)) throw new NodeError("The redirect address must start with http:// or https://.");
      response.status = status >= 300 && status < 400 ? status : 302;
      headers.location = target;
    }
    return { outputs: [ctx.items], respond: response };
  },
};

const stopNode: NodeImpl = {
  type: "core.stop-and-error",
  async execute(ctx) {
    throw new NodeError(String(ctx.param("errorMessage") ?? "Stopped") || "Stopped");
  },
};

const noOpNode: NodeImpl = {
  type: "core.no-op",
  async execute(ctx) {
    return [ctx.items];
  },
};

export const FLOW_IMPLS: NodeImpl[] = [
  passTrigger("core.manual-trigger"),
  passTrigger("core.schedule-trigger"),
  passTrigger("core.webhook"),
  passTrigger("core.execute-workflow-trigger"),
  passTrigger("core.error-trigger"),
  ifNode,
  filterNode,
  switchNode,
  mergeNode,
  loopNode,
  waitNode,
  executeWorkflowNode,
  respondNode,
  stopNode,
  noOpNode,
];
