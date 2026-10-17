import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP (PKWARE APPNOTE) writer and reader for office containers (OOXML and ODF are both ZIPs). Server-only, no
 * dependency: stored + deflate, no ZIP64, no encryption — enough for blank templates and text extraction. The reader caps
 * the total inflated size (zip bombs).
 */

export interface ZipEntryInput {
  name: string;
  data: Buffer | string;
  /** Store without compression (ODF's `mimetype` must be first and stored). */
  store?: boolean;
}

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed 2026-01-01: deterministic output

export function writeZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const body = entry.store ? raw : deflateRawSync(raw);
    const method = entry.store ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export class ZipError extends Error {}

export interface ZipReader {
  names(): string[];
  /** Inflated entry, or null when absent. */
  read(name: string): Buffer | null;
  text(name: string): string | null;
}

/** `maxEntryBytes`: refuse any single entry that inflates beyond it (declared size, enforced by the inflater). */
export function readZip(buffer: Buffer, maxInflatedBytes = 200 * 1024 * 1024, maxEntryBytes = Number.POSITIVE_INFINITY): ZipReader {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a ZIP container");
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; compressed: number; size: number; local: number }>();
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new ZipError("corrupt central directory");
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.set(name, { method, compressed, size, local });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  let inflated = 0;
  const read = (name: string): Buffer | null => {
    const entry = entries.get(name);
    if (!entry) return null;
    const p = entry.local;
    if (buffer.readUInt32LE(p) !== 0x04034b50) throw new ZipError(`corrupt local header for ${name}`);
    const start = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
    const body = buffer.subarray(start, start + entry.compressed);
    if (entry.size > maxEntryBytes) throw new ZipError(`${name} is larger than ${Math.round(maxEntryBytes / 1024 / 1024)} MB`);
    inflated += entry.size;
    if (inflated > maxInflatedBytes) throw new ZipError("archive inflates beyond the limit");
    if (entry.method === 0) return Buffer.from(body);
    if (entry.method === 8) return inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) + 1024 });
    throw new ZipError(`unsupported compression method ${entry.method} for ${name}`);
  };
  return {
    names: () => [...entries.keys()],
    read,
    text: (name) => read(name)?.toString("utf8") ?? null,
  };
}
