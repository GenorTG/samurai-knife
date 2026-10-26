/** Deliberately limited operation coverage, documented per node and operation; not arbitrary HTTP wrappers. */
import { COLLABORATION_INTEGRATIONS } from "./collaboration";
import { PRODUCTIVITY_INTEGRATIONS } from "./productivity";
import type { IntegrationSpec } from "./types";

export const INTEGRATIONS: readonly IntegrationSpec[] = [...COLLABORATION_INTEGRATIONS, ...PRODUCTIVITY_INTEGRATIONS];
