import * as z from "zod/v4";
import { defineTool, KnifeToolForbiddenError, toolAllowed, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { CV_KNIFE_TOOLS } from "./tools-cv";
import { DOC_KNIFE_TOOLS } from "./tools-docs";
import { LEARN_KNIFE_TOOLS } from "./tools-learn";
import { NOSQL_KNIFE_TOOLS } from "./tools-nosql";
import { SQL_KNIFE_TOOLS } from "./tools-sql";
import { computeDiff, MAX_DIFF_LINES } from "@/lib/diff";
import { buildGeneration, type AnchorMode } from "@/lib/regexgen";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { searchToolsLoose } from "@/lib/registry";
import { validateJsonSchema } from "@/lib/json-schema";
import { resolveJsonPointer } from "@/lib/json-pointer";

export type { KnifeToolContext, KnifeToolDefinition } from "./define";

const searchSchema = z.object({
  query: z.string().min(1).max(120),
  limit: z.number().int().min(1).max(16).optional(),
}).strict();

const diffSchema = z.object({
  leftText: z.string().max(60_000),
  rightText: z.string().max(60_000),
  maxLines: z.number().int().min(1).max(MAX_DIFF_LINES).optional(),
}).strict();

const regexSchema = z.object({
  positiveExamples: z.string().min(1).max(20_000),
  negativeExamples: z.string().max(20_000).optional(),
  anchorMode: z.enum(["line", "string", "off"]).optional(),
}).strict();

const jsonSchema = z.object({
  text: z.string().max(200_000),
  indent: z.number().int().min(0).max(8).optional(),
}).strict();

const urlSchema = z.object({
  input: z.string().min(1).max(2_048),
}).strict();

const epochSchema = z.object({
  value: z.string().min(1).max(100),
  unit: z.enum(["auto", "seconds", "milliseconds"]).optional(),
  timeZone: z.string().min(1).max(100).optional(),
}).strict();

const jwtSchema = z.object({
  token: z.string().min(1).max(16_384),
  secret: z.string().max(1_024).optional(),
}).strict();

const textSchema = z.object({
  text: z.string().max(100_000),
}).strict();

const jsonSchemaValidationSchema = z.object({
  schema: z.string().min(1).max(100_000),
  value: z.string().min(1).max(200_000),
}).strict();

const jsonPointerSchema = z.object({
  document: z.string().max(200_000),
  pointer: z.string().max(2_048),
}).strict();

const BASE_KNIFE_TOOLS: KnifeToolDefinition[] = [
  defineTool({
    name: "knife_search_tools",
    scope: "pure",
    description: "Find Samurai Knife UI tools by name, purpose, or keyword.",
    schema: searchSchema,
    run: ({ query, limit }) => searchToolsLoose(query).slice(0, limit ?? 8).map((tool) => ({
      slug: tool.slug,
      name: tool.name,
      category: tool.category,
      tagline: tool.tagline,
      ...(tool.tabs ? { tabs: tool.tabs.map((tab) => tab.id) } : {}),
    })),
  }),
  defineTool({
    name: "knife_hash",
    scope: "pure",
    description: "Hash text (UTF-8) with md5, sha1, sha256, sha384 or sha512 and return the hex digest.",
    schema: z.object({
      text: z.string().max(200_000),
      algorithm: z.enum(["md5", "sha1", "sha256", "sha384", "sha512"]).default("sha256"),
    }).strict(),
    run: ({ text, algorithm }) => ({ algorithm, digest: createHash(algorithm).update(text, "utf8").digest("hex") }),
  }),
  defineTool({
    name: "knife_diff",
    scope: "pure",
    description: "Compare two text values and return line statistics plus a unified patch.",
    schema: diffSchema,
    run: ({ leftText, rightText, maxLines }) => {
      const result = computeDiff(leftText, rightText, maxLines);
      return {
        ok: result.ok,
        error: result.error,
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        patch: result.patch,
      };
    },
  }),
  defineTool({
    name: "knife_generate_regex",
    scope: "pure",
    description: "Generate and verify a regular expression from positive and negative examples.",
    schema: regexSchema,
    run: ({ positiveExamples, negativeExamples, anchorMode }) => {
      const result = buildGeneration(
        positiveExamples,
        negativeExamples ?? "",
        (anchorMode ?? "line") as AnchorMode,
      );
      if (!result) throw new Error("At least one positive example is required.");
      return result;
    },
  }),
  defineTool({
    name: "knife_format_json",
    scope: "pure",
    description: "Parse and pretty-print JSON, returning a readable parse error when invalid.",
    schema: jsonSchema,
    run: ({ text, indent }) => {
      const value: unknown = JSON.parse(text);
      return JSON.stringify(value, null, indent ?? 2);
    },
  }),
  defineTool({
    name: "knife_inspect_url",
    scope: "pure",
    description: "Parse a URL and list its parts and ordered query parameters without fetching it.",
    schema: urlSchema,
    run: ({ input }) => {
      const value = input.trim();
      const url = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`);
      return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        origin: url.origin,
        pathname: url.pathname,
        hash: url.hash,
        queryParameters: [...url.searchParams.entries()].map(([name, parameterValue]) => ({
          name,
          value: parameterValue,
        })),
        containsCredentials: Boolean(url.username || url.password),
      };
    },
  }),
  defineTool({
    name: "knife_convert_epoch",
    scope: "pure",
    description: "Convert an ISO date or Unix timestamp to UTC and a selected IANA time zone.",
    schema: epochSchema,
    run: ({ value, unit, timeZone }) => {
      const text = value.trim();
      const numeric = Number(text);
      const isNumeric = text.length > 0 && Number.isFinite(numeric);
      const resolvedUnit = unit && unit !== "auto"
        ? unit
        : Math.abs(numeric) < 100_000_000_000 ? "seconds" : "milliseconds";
      const date = isNumeric
        ? new Date(resolvedUnit === "seconds" ? numeric * 1_000 : numeric)
        : new Date(value);
      if (!Number.isFinite(date.getTime())) throw new Error("The value is not a valid timestamp or date.");

      const zone = timeZone ?? "UTC";
      const inTimeZone = new Intl.DateTimeFormat("en-GB", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: zone,
      }).format(date);
      return {
        input: value,
        unit: isNumeric ? resolvedUnit : "date",
        unixSeconds: Math.floor(date.getTime() / 1_000),
        unixMilliseconds: date.getTime(),
        isoUtc: date.toISOString(),
        timeZone: zone,
        inTimeZone,
      };
    },
  }),
  defineTool({
    name: "knife_decode_jwt",
    scope: "pure",
    description: "Decode a JWT's header and payload locally. Pass secret to verify an HS256/HS384/HS512 signature (verified true/false); without it verified is null: the signature was NOT checked, which is not the same as invalid.",
    schema: jwtSchema,
    run: ({ token, secret }) => {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("A JWT must contain three dot-separated parts.");
      const decodeJson = (part: string): unknown => {
        const decoded: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        return decoded;
      };
      const header = decodeJson(parts[0]) as { alg?: unknown };
      const algs: Record<string, string> = { HS256: "sha256", HS384: "sha384", HS512: "sha512" };
      // null = not checked. `false` used to mean both "no secret given" and "wrong secret", so a model reported valid tokens as forged.
      let verified: boolean | null = null;
      let verifyNote: string | undefined = secret === undefined ? "No secret was given: the signature was not checked." : undefined;
      if (secret !== undefined) {
        const hash = typeof header.alg === "string" ? algs[header.alg] : undefined;
        if (!hash) {
          verified = null;
          verifyNote = `alg ${String(header.alg)} cannot be verified with a shared secret here (HS256/384/512 only).`;
        } else {
          const expected = createHmac(hash, secret).update(`${parts[0]}.${parts[1]}`).digest();
          const given = Buffer.from(parts[2], "base64url");
          verified = given.length === expected.length && timingSafeEqual(given, expected);
        }
      }
      return {
        header,
        payload: decodeJson(parts[1]),
        signaturePresent: parts[2].length > 0,
        verified,
        ...(verifyNote ? { verifyNote } : {}),
      };
    },
  }),
  defineTool({
    name: "knife_count_text",
    scope: "pure",
    description: "Count user-perceived characters (graphemes), Unicode code points, UTF-8 bytes, words and lines in text.",
    schema: textSchema,
    run: ({ text }) => ({
      characters: Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length,
      codePoints: Array.from(text).length,
      utf8Bytes: Buffer.byteLength(text, "utf8"),
      words: text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0,
      lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
    }),
  }),
  defineTool({
    name: "knife_validate_json_schema",
    scope: "pure",
    description: "Validate a JSON value against a JSON Schema Draft 2020-12 schema, including common format checks.",
    schema: jsonSchemaValidationSchema,
    run: ({ schema, value }) => {
      let parsedSchema: unknown;
      let parsedValue: unknown;
      try {
        parsedSchema = JSON.parse(schema) as unknown;
      } catch (error) {
        throw new Error(`Invalid JSON Schema text: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        parsedValue = JSON.parse(value) as unknown;
      } catch (error) {
        throw new Error(`Invalid JSON value text: ${error instanceof Error ? error.message : String(error)}`);
      }
      return validateJsonSchema(parsedSchema, parsedValue);
    },
  }),
  defineTool({
    name: "knife_get_json_pointer",
    scope: "pure",
    description: "Read a nested value from JSON using an RFC 6901 JSON Pointer; does not fetch URLs or files.",
    schema: jsonPointerSchema,
    run: ({ document, pointer }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(document) as unknown;
      } catch (error) {
        throw new Error(`Invalid JSON document: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { pointer, ...resolveJsonPointer(parsed, pointer) };
    },
  }),
];

export const KNIFE_TOOLS: KnifeToolDefinition[] = [...BASE_KNIFE_TOOLS, ...SQL_KNIFE_TOOLS, ...NOSQL_KNIFE_TOOLS, ...CV_KNIFE_TOOLS, ...DOC_KNIFE_TOOLS, ...LEARN_KNIFE_TOOLS];

/** The tools this caller may see and call (`scope`, define.ts). Every listing and every dispatch goes through it. */
export function toolsFor(ctx: KnifeToolContext | undefined): KnifeToolDefinition[] {
  return KNIFE_TOOLS.filter((tool) => toolAllowed(tool, ctx));
}

export function getOpenAiToolDefinitions(ctx: KnifeToolContext) {
  return toolsFor(ctx).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { target: "draft-7" }) as Record<string, unknown>,
    },
  }));
}

export async function callKnifeTool(name: string, input: unknown, ctx?: KnifeToolContext): Promise<unknown> {
  const tool = KNIFE_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Unknown Samurai Knife tool: ${name}`);
  if (tool.scope === "admin" && ctx?.accountId && !ctx.admin) throw new KnifeToolForbiddenError(name);
  return tool.execute(input, ctx);
}

export function serializeKnifeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}
