/** Browser-safe, declarative service contracts. No transport, credentials or Node built-ins here. */
import type { NodeParam } from "../types";

export interface IntegrationField {
  parameter: NodeParam;
  location: "path" | "query" | "body";
  target: string;
  validate?: "object" | "properties" | "matrix" | "blocks" | "instant" | "recipients";
  transform?: "recipients" | "array";
}

export interface IntegrationPagination {
  /** No server-provided URL is followed. Graph next links contribute only checked skip tokens. */
  mode: "page" | "cursor" | "before" | "graph";
  limitKey: string;
  maxPageSize: number;
  location?: "query" | "body";
  cursorKey?: string;
  cursorPath?: string;
}

export interface IntegrationOperation {
  id: string;
  label: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  fields: IntegrationField[];
  docs: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  /** A collection in the JSON envelope; absent means emit the whole response (including scalars). */
  output?: string;
  /** Some Google collections omit an empty collection property. */
  optionalOutput?: boolean;
  pagination?: IntegrationPagination;
  timeOrder?: [string, string];
}

export interface IntegrationSpec {
  type: string;
  label: string;
  description: string;
  baseUrl: string;
  credentialTypes: string[];
  credentialHelp: string;
  headers?: Record<string, string>;
  envelope?: "slack";
  operations: IntegrationOperation[];
}

export function text(name: string, label: string, location: IntegrationField["location"], target = name, required = true, defaultValue?: string): IntegrationField {
  return { parameter: { name, label, type: "string", required, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }, location, target };
}

export function json(name: string, label: string, target: string, validate: IntegrationField["validate"], defaultValue = "{}"): IntegrationField {
  return { parameter: { name, label, type: "json", required: true, default: defaultValue, rows: 5 }, location: "body", target, validate };
}

export function choice(name: string, label: string, location: IntegrationField["location"], values: string[], defaultValue: string): IntegrationField {
  return { parameter: { name, label, type: "options", default: defaultValue, options: values.map((value) => ({ value, label: value })) }, location, target: name };
}

export const TOKEN_TYPES = ["httpBearerAuth", "httpHeaderAuth", "oAuth2Api"];
export const GOOGLE_TYPES = ["oAuth2Api", "httpBearerAuth"];
export const GRAPH_TYPES = ["oAuth2Api", "httpBearerAuth"];
