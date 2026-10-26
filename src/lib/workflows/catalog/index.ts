/**
 * Every node type the workflow editor offers (metadata only: safe for the browser). The worker's implementations
 * (src/lib/workflows/nodes/index.ts) must cover exactly these types: tests/workflow_engine.test.mjs checks it.
 */
import type { NodeMeta } from "../types";
import { AI_NODES } from "./ai";
import { DATA_NODES } from "./data";
import { FLOW_NODES } from "./flow";
import { NETWORK_NODES } from "./network";
import { INTEGRATION_NODES } from "./integrations";

export const NODE_CATALOG: readonly NodeMeta[] = [...FLOW_NODES, ...DATA_NODES, ...NETWORK_NODES, ...AI_NODES, ...INTEGRATION_NODES];

const BY_TYPE = new Map(NODE_CATALOG.map((meta) => [meta.type, meta]));

export function nodeMeta(type: string): NodeMeta | undefined {
  return BY_TYPE.get(type);
}

export function isTrigger(type: string): boolean {
  return (BY_TYPE.get(type)?.inputs ?? 1) === 0;
}
