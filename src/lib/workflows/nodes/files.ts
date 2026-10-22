/** File node implementations (metadata: src/lib/workflows/catalog/data.ts). Bytes live in the run's blob store. */
import { gunzipSync, gzipSync } from "node:zlib";
import { columnKeys } from "../../csv-convert";
import { parseDelimited } from "../../delimited";
import { NodeError, type NodeImpl } from "../engine/node-api";
import type { Item, JsonObject } from "../types";
import { binaryOf, extensionFor, getPath, isPlainObject, setPath } from "./util";

/** Unzipped/decoded files may be at most this large (a zip bomb stops here). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function csvCell(value: unknown, delimiter: string): string {
  const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /["\r\n]/.test(text) || text.includes(delimiter) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: JsonObject[], delimiter = ",", header = true): string {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) {
    seen.add(key);
    columns.push(key);
  }
  const lines = rows.map((row) => columns.map((column) => csvCell(row[column], delimiter)).join(delimiter));
  return `${[...(header ? [columns.map((column) => csvCell(column, delimiter)).join(delimiter)] : []), ...lines].join("\r\n")}\r\n`;
}

function icsDate(value: unknown): string {
  const ms = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(ms)) throw new NodeError(`${JSON.stringify(value)} is not a date.`);
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const icsText = (value: unknown) => String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const convertToFileNode: NodeImpl = {
  type: "core.convert-to-file",
  async execute(ctx) {
    const operation = ctx.param<string>("operation");
    const target = String(ctx.param("binaryProperty") || "data");
    const named = (fallback: string, index = 0) => String(ctx.param("fileName", index) || "") || fallback;
    const put = (bytes: Uint8Array, mimeType: string, fileName: string) => ctx.services.blobs.put(bytes, { mimeType, fileName });
    if ((operation === "csv" || operation === "json") && !ctx.param<boolean>("eachItem")) {
      const rows = ctx.items.map((item) => item.json);
      const text = operation === "csv" ? toCsv(rows, String(ctx.param("delimiter") || ","), ctx.param<boolean>("header") !== false) : JSON.stringify(rows, null, 2);
      const mime = operation === "csv" ? "text/csv" : "application/json";
      return [[{ json: {}, binary: { [target]: put(Buffer.from(text, "utf8"), mime, named(`data.${operation}`)) } }]];
    }
    return [
      ctx.items.map((item, index) => {
        let ref;
        if (operation === "csv") ref = put(Buffer.from(toCsv([item.json], String(ctx.param("delimiter", index) || ","), ctx.param<boolean>("header", index) !== false), "utf8"), "text/csv", named(`data-${index + 1}.csv`, index));
        else if (operation === "json") ref = put(Buffer.from(JSON.stringify(item.json, null, 2), "utf8"), "application/json", named(`data-${index + 1}.json`, index));
        else if (operation === "text") {
          const value = getPath(item.json, String(ctx.param("sourceField", index) || "data"));
          const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
          ref = put(Buffer.from(text, "utf8"), String(ctx.param("mimeType", index) || "text/plain"), named("file.txt", index));
        } else if (operation === "base64") {
          const value = String(getPath(item.json, String(ctx.param("sourceField", index) || "data")) ?? "");
          const clean = value.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");
          if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new NodeError("The field is not base64.", { itemIndex: index });
          const bytes = Buffer.from(clean, "base64");
          const mime = String(ctx.param("mimeType", index) || /^data:([^;,]+)/.exec(value)?.[1] || "application/octet-stream");
          ref = put(bytes, mime, named(`file.${extensionFor(mime)}`, index));
        } else if (operation === "ics") {
          const lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//Smart Knife//Workflows//EN",
            "BEGIN:VEVENT",
            `UID:${ctx.executionId}-${index}@smart-knife`,
            `DTSTAMP:${icsDate(ctx.now())}`,
            `DTSTART:${icsDate(ctx.param("start", index))}`,
            `DTEND:${icsDate(ctx.param("end", index) || ctx.param("start", index))}`,
            `SUMMARY:${icsText(ctx.param("title", index))}`,
            "END:VEVENT",
            "END:VCALENDAR",
          ];
          ref = put(Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"), "text/calendar", named("event.ics", index));
        } else throw new NodeError(`Unknown conversion "${operation}".`);
        return { json: item.json, binary: { ...item.binary, [target]: ref }, pairedItem: index };
      }),
    ];
  },
};

const extractFromFileNode: NodeImpl = {
  type: "core.extract-from-file",
  async execute(ctx) {
    const operation = ctx.param<string>("operation");
    const out: Item[] = [];
    ctx.items.forEach((item, index) => {
      const property = String(ctx.param("binaryProperty", index) || "data");
      const ref = binaryOf(item, property, ctx.node.name);
      const bytes = ctx.services.blobs.get(ref);
      const destination = String(ctx.param("destinationKey", index) || "data");
      if (operation === "csv") {
        const rows = parseDelimited(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""), String(ctx.param("delimiter", index) || ","));
        const header = ctx.param<boolean>("header", index) !== false;
        const width = Math.max(0, ...rows.map((row) => row.length));
        const keys = header ? columnKeys(rows[0] ?? [], width) : Array.from({ length: width }, (_, column) => `column_${column + 1}`);
        for (const row of header ? rows.slice(1) : rows) {
          if (row.length === 1 && row[0] === "") continue;
          out.push({ json: Object.fromEntries(keys.map((key, column) => [key, row[column] ?? ""])), pairedItem: index });
        }
        return;
      }
      const json = { ...item.json };
      if (operation === "json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""));
        } catch (error) {
          throw new NodeError(`The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { itemIndex: index });
        }
        if (Array.isArray(parsed) && parsed.every(isPlainObject)) {
          for (const entry of parsed) out.push({ json: entry, pairedItem: index });
          return;
        }
        setPath(json, destination, parsed);
      } else if (operation === "text") setPath(json, destination, new TextDecoder().decode(bytes));
      else if (operation === "base64") setPath(json, destination, Buffer.from(bytes).toString("base64"));
      else throw new NodeError(`Unknown extraction "${operation}".`);
      out.push({ json, ...(item.binary ? { binary: item.binary } : {}), pairedItem: index });
    });
    return [out];
  },
};

const compressionNode: NodeImpl = {
  type: "core.compression",
  async execute(ctx) {
    return [
      ctx.items.map((item, index) => {
        const property = String(ctx.param("binaryProperty", index) || "data");
        const ref = binaryOf(item, property, ctx.node.name);
        const bytes = ctx.services.blobs.get(ref);
        const output = String(ctx.param("outputProperty", index) || "data");
        let result;
        if (ctx.param("operation", index) === "decompress") {
          let raw: Buffer;
          try {
            raw = gunzipSync(bytes, { maxOutputLength: MAX_FILE_BYTES });
          } catch (error) {
            throw new NodeError(/maxOutputLength|buffer/i.test(String(error)) ? `The unpacked file is larger than ${MAX_FILE_BYTES / 1048576} MB.` : "The file is not gzip data.", { itemIndex: index });
          }
          const name = (ref.fileName ?? "file.gz").replace(/\.gz$/i, "") || "file";
          result = ctx.services.blobs.put(raw, { mimeType: "application/octet-stream", fileName: name });
        } else {
          result = ctx.services.blobs.put(gzipSync(bytes), { mimeType: "application/gzip", fileName: `${ref.fileName ?? "file"}.gz` });
        }
        return { json: item.json, binary: { ...item.binary, [output]: result }, pairedItem: index };
      }),
    ];
  },
};

export const FILE_IMPLS: NodeImpl[] = [convertToFileNode, extractFromFileNode, compressionNode];
