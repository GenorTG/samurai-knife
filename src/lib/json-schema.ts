import Ajv2020, { type AnySchema, type ErrorObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";

export interface JsonSchemaIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type JsonSchemaValidation =
  | { valid: true; issues: [] }
  | { valid: false; issues: JsonSchemaIssue[] };

export function validateJsonSchema(schema: unknown, value: unknown): JsonSchemaValidation {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema as AnySchema);
  const valid = validate(value);
  if (valid) return { valid: true, issues: [] };

  return {
    valid: false,
    issues: (validate.errors ?? []).map((issue: ErrorObject) => ({
      instancePath: issue.instancePath || "/",
      schemaPath: issue.schemaPath,
      keyword: issue.keyword,
      message: issue.message ?? "does not match the schema",
      params: issue.params as Record<string, unknown>,
    })),
  };
}
