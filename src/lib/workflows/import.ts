/**
 * Imports an n8n workflow export (its JSON format is documented: nodes with `type`, `parameters`, `position`, and
 * `connections` keyed by node name) into the Smart Knife model, for the nodes Smart Knife has (docs/research/n8n-nodes.md).
 * Parameter shapes of the common nodes are translated; credentials are not carried over (choose them again); an
 * unsupported node becomes a No Operation node whose notes say what it was.
 */
import type { Connection, WorkflowNode } from "./types";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const TYPES: Record<string, string> = {
  manualTrigger: "core.manual-trigger",
  scheduleTrigger: "core.schedule-trigger",
  cron: "core.schedule-trigger",
  webhook: "core.webhook",
  respondToWebhook: "core.respond-to-webhook",
  httpRequest: "core.http-request",
  graphql: "core.graphql",
  code: "core.code",
  function: "core.code",
  set: "core.set",
  if: "core.if",
  filter: "core.filter",
  switch: "core.switch",
  merge: "core.merge",
  splitInBatches: "core.loop",
  wait: "core.wait",
  noOp: "core.no-op",
  stopAndError: "core.stop-and-error",
  executeWorkflow: "core.execute-workflow",
  executeWorkflowTrigger: "core.execute-workflow-trigger",
  errorTrigger: "core.error-trigger",
  splitOut: "core.split-out",
  aggregate: "core.aggregate",
  sort: "core.sort",
  limit: "core.limit",
  removeDuplicates: "core.remove-duplicates",
  renameKeys: "core.rename-keys",
  summarize: "core.summarize",
  compareDatasets: "core.compare-datasets",
  dateTime: "core.date-time",
  crypto: "core.crypto",
  jwt: "core.jwt",
  totp: "core.totp",
  markdown: "core.markdown",
  convertToFile: "core.convert-to-file",
  extractFromFile: "core.extract-from-file",
  compression: "core.compression",
  executionData: "core.execution-data",
  debugHelper: "core.debug-helper",
};

const pairs = (value: unknown, key = "parameters") => arr(obj(value)[key]).map((row) => ({ name: String(obj(row).name ?? ""), value: obj(row).value ?? "" }));

function conditions(value: unknown): Json {
  const set = obj(value);
  return {
    combinator: set.combinator === "or" ? "or" : "and",
    conditions: arr(set.conditions).map((row) => {
      const entry = obj(row);
      const operator = obj(entry.operator);
      return { leftValue: entry.leftValue ?? "", operator: `${String(operator.type ?? "string")}:${String(operator.operation ?? "equals")}`, rightValue: entry.rightValue ?? "" };
    }),
  };
}

function translate(type: string, p: Json): Json {
  switch (type) {
    case "core.http-request": {
      const contentType = { json: "json", "form-urlencoded": "form", "multipart-form-data": "multipart", raw: "raw", binaryData: "binary" }[String(p.contentType ?? "json")] ?? "json";
      const options = obj(p.options);
      return {
        method: p.method ?? "GET",
        url: p.url ?? "",
        sendQuery: Boolean(p.sendQuery),
        query: pairs(p.queryParameters),
        sendHeaders: Boolean(p.sendHeaders),
        headers: pairs(p.headerParameters),
        sendBody: Boolean(p.sendBody),
        contentType,
        bodyMode: p.specifyBody === "json" ? "json" : "fields",
        jsonFields: pairs(p.bodyParameters),
        bodyFields: pairs(p.bodyParameters),
        jsonBody: p.jsonBody ?? "{}",
        rawBody: p.body ?? "",
        options: { ...(options.timeout ? { timeout: options.timeout } : {}), ...(obj(obj(options.response).response).neverError ? { neverError: true } : {}) },
      };
    }
    case "core.set": {
      if (p.mode === "raw") return { mode: "raw", jsonOutput: p.jsonOutput ?? "{}", include: p.includeOtherFields === false ? "none" : "all" };
      const assignments = arr(obj(p.assignments).assignments).map((row) => {
        const entry = obj(row);
        return { name: entry.name ?? "", type: entry.type ?? "string", value: entry.value ?? "" };
      });
      return { mode: "manual", assignments, include: p.includeOtherFields === false ? "none" : "all" };
    }
    case "core.if":
    case "core.filter":
      return { conditions: conditions(p.conditions), options: { ignoreCase: Boolean(obj(p.options).ignoreCase), looseTypes: Boolean(p.looseTypeValidation ?? obj(p.options).looseTypeValidation) } };
    case "core.switch": {
      if (p.mode === "expression") return { mode: "expression", numberOutputs: p.numberOutputs ?? 4, output: p.output ?? "={{ 0 }}" };
      const rules = arr(obj(p.rules).values).map((row) => ({ conditions: conditions(obj(row).conditions), outputKey: obj(row).outputKey ?? "" }));
      const options = obj(p.options);
      return { mode: "rules", rules, options: { fallbackOutput: options.fallbackOutput === "extra" ? "extra" : "none", allMatchingOutputs: Boolean(options.allMatchingOutputs) } };
    }
    case "core.merge": {
      const mode = String(p.mode ?? "append");
      if (mode === "combine" || mode === "combineByFields" || mode === "combineByPosition" || mode === "combineAll") {
        const by = String(p.combineBy ?? mode);
        const fields = arr(obj(p.fieldsToMatchString ? {} : p.fields).values).map((row) => ({ field1: obj(row).field1 ?? "", field2: obj(row).field2 ?? "" }));
        const joinMode = { keepMatches: "keepMatches", keepNonMatches: "keepNonMatches", keepEverything: "keepEverything", enrichInput1: "enrichInput1", enrichInput2: "enrichInput2" }[String(p.joinMode ?? "keepMatches")] ?? "keepMatches";
        return { mode: by === "combineByPosition" ? "combineByPosition" : by === "combineAll" ? "combineAll" : "combineByFields", fields: fields.length ? fields : [{ field1: "id", field2: "id" }], joinMode };
      }
      return { mode: mode === "chooseBranch" ? "chooseBranch" : "append" };
    }
    case "core.schedule-trigger": {
      const intervals = arr(obj(p.rule).interval);
      const rules = intervals.map((row) => {
        const entry = obj(row);
        const field = String(entry.field ?? "minutes");
        if (field === "cronExpression") return { every: "cron", cron: entry.expression ?? "0 9 * * *" };
        const amountKey = { seconds: "secondsInterval", minutes: "minutesInterval", hours: "hoursInterval", days: "daysInterval", weeks: "weeksInterval", months: "monthsInterval" }[field] ?? "minutesInterval";
        return { every: field, amount: entry[amountKey] ?? 1, atHour: entry.triggerAtHour ?? 0, atMinute: entry.triggerAtMinute ?? 0, weekday: String(arr(entry.triggerAtDay)[0] ?? 1), dayOfMonth: entry.triggerAtDayOfMonth ?? 1 };
      });
      return { rules: rules.length ? rules : [{ every: "minutes", amount: 15 }] };
    }
    case "core.code":
      return p.mode === "runOnceForEachItem" ? { mode: "runOnceForEachItem", jsCodeEach: p.jsCode ?? "" } : { mode: "runOnceForAllItems", jsCode: p.jsCode ?? p.functionCode ?? "" };
    case "core.aggregate":
      return p.aggregate === "aggregateAllItemData"
        ? { aggregate: "allItemData", destinationFieldName: p.destinationFieldName ?? "data" }
        : { aggregate: "individualFields", fieldsToAggregate: arr(obj(p.fieldsToAggregate).fieldToAggregate).map((row) => ({ field: obj(row).fieldToAggregate ?? "", outputField: obj(row).renameField ? obj(row).outputFieldName ?? "" : "" })) };
    case "core.sort":
      return p.type === "random" ? { type: "random" } : { type: "simple", fields: arr(obj(p.sortFieldsUi).sortField).map((row) => ({ field: obj(row).fieldName ?? "", order: obj(row).order ?? "ascending" })) };
    case "core.rename-keys":
      return { keys: arr(obj(p.keys).key).map((row) => ({ currentKey: obj(row).currentKey ?? "", newKey: obj(row).newKey ?? "" })) };
    case "core.execute-workflow":
      return { workflowId: typeof p.workflowId === "string" ? p.workflowId : String(obj(p.workflowId).value ?? ""), mode: p.mode === "each" ? "each" : "once", waitForSubWorkflow: obj(p.options).waitForSubWorkflow !== false };
    case "core.respond-to-webhook":
      return { respondWith: p.respondWith ?? "firstIncomingItem", responseBody: p.responseBody ?? "{}", responseText: p.responseBody ?? "", redirectUrl: p.redirectURL ?? "", responseCode: obj(p.options).responseCode ?? 200, headers: pairs(obj(obj(p.options).responseHeaders), "entries") };
    default:
      return p;
  }
}

export function fromN8n(input: unknown): { name: string; nodes: WorkflowNode[]; connections: Connection[]; skipped: string[] } | null {
  const data = obj(input);
  const rawNodes = arr(data.nodes);
  if (!rawNodes.length || typeof data.connections !== "object") return null;
  const skipped: string[] = [];
  const names = new Set<string>();
  const nodes: WorkflowNode[] = [];
  rawNodes.forEach((raw, index) => {
    const entry = obj(raw);
    const full = String(entry.type ?? "");
    const short = full.replace(/^n8n-nodes-base\./, "");
    const mapped = full.startsWith("n8n-nodes-base.") ? TYPES[short] : undefined;
    let name = String(entry.name ?? `Node ${index + 1}`).slice(0, 80).replace(/[\0\n\r]/g, " ").trim() || `Node ${index + 1}`;
    while (names.has(name)) name = `${name} ${index}`;
    names.add(name);
    const position = arr(entry.position);
    const node: WorkflowNode = {
      id: String(entry.id ?? `n${index}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || `n${index}`,
      type: mapped ?? "core.no-op",
      typeVersion: 1,
      name,
      position: [Number(position[0]) || index * 220, Number(position[1]) || 0],
      parameters: mapped ? translate(mapped, obj(entry.parameters)) : {},
      ...(entry.disabled ? { disabled: true } : {}),
      ...(mapped ? {} : { notes: `Imported from n8n: ${full} (not available in Smart Knife yet).` }),
    };
    if (!mapped) skipped.push(`${name} (${short || full})`);
    nodes.push(node);
  });
  const ids = new Set<string>();
  for (const node of nodes) {
    while (ids.has(node.id)) node.id = `${node.id}x`;
    ids.add(node.id);
  }
  const nameMap = new Map(rawNodes.map((raw, index) => [String(obj(raw).name ?? ""), nodes[index].name]));
  const connections: Connection[] = [];
  for (const [from, outputs] of Object.entries(obj(data.connections))) {
    const source = nameMap.get(from);
    if (!source) continue;
    arr(obj(outputs).main).forEach((targets, output) => {
      for (const target of arr(targets)) {
        const to = nameMap.get(String(obj(target).node ?? ""));
        if (to) connections.push({ from: { node: source, output }, to: { node: to, input: Number(obj(target).index) || 0 } });
      }
    });
  }
  return { name: String(data.name ?? "Imported workflow").slice(0, 120) || "Imported workflow", nodes, connections, skipped };
}
