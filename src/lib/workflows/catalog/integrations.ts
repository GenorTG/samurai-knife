/** Same service contracts drive editor fields and worker requests; this module is safe in the browser. */
import { INTEGRATIONS } from "../integrations/index";
import type { NodeMeta, NodeParam } from "../types";

export const INTEGRATION_NODES: NodeMeta[] = INTEGRATIONS.map((spec) => {
  const fields = new Map<string, NodeParam>();
  for (const operation of spec.operations) for (const { parameter } of operation.fields) {
    const existing = fields.get(parameter.name);
    if (existing) existing.showIf!.operation.push(operation.id);
    else fields.set(parameter.name, { ...parameter, showIf: { operation: [operation.id] } });
  }
  const paginated = spec.operations.filter((operation) => operation.pagination).map((operation) => operation.id);
  return {
    type: spec.type, label: spec.label, group: "apps", inputs: 1, outputs: ["main"], hue: 210, version: 1,
    description: spec.description, keywords: [spec.label, "integration", "app"],
    credentials: [{ name: "auth", label: "Service connection", required: true, types: [...spec.credentialTypes] }],
    params: [
      { name: "operation", label: "Operation", type: "options", default: spec.operations[0].id, options: spec.operations.map((operation) => ({ value: operation.id, label: operation.label })) },
      { name: "connectionHelp", label: spec.credentialHelp, type: "notice", noExpression: true },
      ...fields.values(),
      ...(paginated.length ? [
        { name: "limit", label: "Maximum results per input", type: "number", default: 50, min: 1, max: 1000, showIf: { operation: paginated }, description: "Total result cap, not page size. A page budget can return fewer results." },
        { name: "maxPages", label: "Maximum pages", type: "number", default: 1, min: 1, max: 10, showIf: { operation: paginated }, description: "At most 10 requests per input (plus OAuth refresh). Defaults to one page; increase explicitly for more." },
      ] satisfies NodeParam[] : []),
    ],
  };
});
