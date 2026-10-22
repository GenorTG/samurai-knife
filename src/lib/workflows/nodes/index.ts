/**
 * Every node implementation, by type (workflow worker and unit tests only: imports node built-ins). Must cover exactly
 * the catalog (src/lib/workflows/catalog/index.ts): tests/workflow_engine.test.mjs checks it.
 */
import type { NodeImpl } from "../engine/node-api";
import { AI_IMPLS } from "./ai";
import { DATA_IMPLS } from "./data";
import { FILE_IMPLS } from "./files";
import { FLOW_IMPLS } from "./flow";
import { HTTP_IMPLS } from "./http";
import { TRANSFORM_IMPLS } from "./transform";

export const NODE_IMPLS: readonly NodeImpl[] = [...FLOW_IMPLS, ...DATA_IMPLS, ...TRANSFORM_IMPLS, ...FILE_IMPLS, ...HTTP_IMPLS, ...AI_IMPLS];

const BY_TYPE = new Map(NODE_IMPLS.map((impl) => [impl.type, impl]));

export function nodeImpl(type: string): NodeImpl | undefined {
  return BY_TYPE.get(type);
}
