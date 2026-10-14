/**
 * Connection-string model for the Connection tab. Pure functions, no network: nothing here ever opens a connection.
 * Build and parse are exact inverses for every kind (user/password/database are percent-encoded, `params` is kept verbatim).
 */

export type DsnKind =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "sqlserver"
  | "oracle"
  | "mongodb"
  | "mongodb-srv"
  | "redis"
  | "rediss"
  | "clickhouse"
  | "chroma"
  | "chroma-tls";

export interface DsnFields {
  kind: DsnKind;
  host: string;
  port: string;
  user: string;
  password: string;
  /** Database / service name / redis db index / sqlite file path. */
  database: string;
  /** Query string without the leading `?`, kept exactly as typed. */
  params: string;
}

export interface KindInfo {
  id: DsnKind;
  label: string;
  scheme: string;
  defaultPort: string;
  databaseLabel: string;
  /** Environment variable name suggested for the URL. */
  envVar: string;
  hasAuth: boolean;
  /** `host` may be a comma-separated host:port list (MongoDB replica sets). */
  multiHost?: boolean;
  /** No port in the URL (SRV records choose it). */
  noPort?: boolean;
  /** Port-less file URL: `scheme:///path`. */
  file?: boolean;
  example: string;
}

export const DSN_KINDS: KindInfo[] = [
  { id: "postgres", label: "PostgreSQL", scheme: "postgresql", defaultPort: "5432", databaseLabel: "Database", envVar: "DATABASE_URL", hasAuth: true, example: "postgresql://app:s3cret@db.internal:5432/shop?sslmode=require" },
  { id: "mysql", label: "MySQL", scheme: "mysql", defaultPort: "3306", databaseLabel: "Database", envVar: "DATABASE_URL", hasAuth: true, example: "mysql://app:s3cret@db.internal:3306/shop?charset=utf8mb4" },
  { id: "mariadb", label: "MariaDB", scheme: "mariadb", defaultPort: "3306", databaseLabel: "Database", envVar: "DATABASE_URL", hasAuth: true, example: "mariadb://app:s3cret@db.internal:3306/shop" },
  { id: "sqlite", label: "SQLite (file)", scheme: "sqlite", defaultPort: "", databaseLabel: "File path", envVar: "DATABASE_URL", hasAuth: false, file: true, example: "sqlite:///./data/app.db" },
  { id: "sqlserver", label: "SQL Server", scheme: "sqlserver", defaultPort: "1433", databaseLabel: "Database", envVar: "DATABASE_URL", hasAuth: true, example: "sqlserver://sa:s3cret@db.internal:1433/shop?encrypt=true" },
  { id: "oracle", label: "Oracle", scheme: "oracle", defaultPort: "1521", databaseLabel: "Service name", envVar: "ORACLE_URL", hasAuth: true, example: "oracle://app:s3cret@db.internal:1521/ORCLPDB1" },
  { id: "mongodb", label: "MongoDB", scheme: "mongodb", defaultPort: "27017", databaseLabel: "Database", envVar: "MONGODB_URI", hasAuth: true, multiHost: true, example: "mongodb://app:s3cret@db1.internal:27017,db2.internal:27017/shop?replicaSet=rs0&authSource=admin" },
  { id: "mongodb-srv", label: "MongoDB Atlas (mongodb+srv)", scheme: "mongodb+srv", defaultPort: "", databaseLabel: "Database", envVar: "MONGODB_URI", hasAuth: true, noPort: true, example: "mongodb+srv://app:s3cret@cluster0.abcde.mongodb.net/shop?retryWrites=true&w=majority" },
  { id: "redis", label: "Redis", scheme: "redis", defaultPort: "6379", databaseLabel: "Database index", envVar: "REDIS_URL", hasAuth: true, example: "redis://default:s3cret@cache.internal:6379/0" },
  { id: "rediss", label: "Redis (TLS, rediss)", scheme: "rediss", defaultPort: "6379", databaseLabel: "Database index", envVar: "REDIS_URL", hasAuth: true, example: "rediss://default:s3cret@cache.internal:6380/0" },
  { id: "clickhouse", label: "ClickHouse", scheme: "clickhouse", defaultPort: "8123", databaseLabel: "Database", envVar: "CLICKHOUSE_URL", hasAuth: true, example: "clickhouse://default:s3cret@ch.internal:8123/analytics" },
  { id: "chroma", label: "Chroma (http)", scheme: "http", defaultPort: "8000", databaseLabel: "Path", envVar: "CHROMA_URL", hasAuth: false, example: "http://localhost:8000" },
  { id: "chroma-tls", label: "Chroma (https)", scheme: "https", defaultPort: "443", databaseLabel: "Path", envVar: "CHROMA_URL", hasAuth: false, example: "https://chroma.example.com:443" },
];

export function kindInfo(kind: DsnKind): KindInfo {
  return DSN_KINDS.find((k) => k.id === kind) ?? DSN_KINDS[0];
}

export function emptyFields(kind: DsnKind): DsnFields {
  const info = kindInfo(kind);
  return { kind, host: "", port: info.defaultPort, user: "", password: "", database: "", params: "" };
}

/** Percent-encode one URL component: every reserved character (`@ : / ? # % [ ]` …) is escaped. */
export function enc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const PASSWORD_MASK = "••••••••";

/** Build the URL. `maskPassword` swaps the secret for a fixed mask so the output is safe to show. */
export function buildDsn(fields: DsnFields, maskPassword = false): string {
  const info = kindInfo(fields.kind);
  const query = fields.params.trim().replace(/^\?/, "");
  const suffix = query ? `?${query}` : "";
  if (info.file) {
    return `${info.scheme}:///${fields.database.trim()}${suffix}`;
  }
  let auth = "";
  if (info.hasAuth && (fields.user || fields.password)) {
    const secret = fields.password ? (maskPassword ? PASSWORD_MASK : enc(fields.password)) : "";
    auth = `${enc(fields.user)}${fields.password ? `:${secret}` : ""}@`;
  }
  const host = fields.host.trim();
  const port = !info.noPort && !info.multiHost && fields.port.trim() ? `:${fields.port.trim()}` : "";
  const path = fields.database ? `/${enc(fields.database)}` : "";
  return `${info.scheme}://${auth}${host}${port}${path}${suffix}`;
}

function decode(value: string): { text: string; bad: boolean } {
  try {
    return { text: decodeURIComponent(value), bad: false };
  } catch {
    return { text: value, bad: true };
  }
}

export type ParseResult = { ok: true; fields: DsnFields; notes: string[] } | { ok: false; error: string };

const SCHEME_TO_KIND: Record<string, DsnKind> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlite: "sqlite",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  oracle: "oracle",
  mongodb: "mongodb",
  "mongodb+srv": "mongodb-srv",
  redis: "redis",
  rediss: "rediss",
  clickhouse: "clickhouse",
  http: "chroma",
  https: "chroma-tls",
};

/** Drop a driver suffix: `postgresql+psycopg` -> `postgresql`, `mssql+pyodbc` -> `mssql` (but keep `mongodb+srv`). */
function baseScheme(scheme: string): string {
  if (scheme === "mongodb+srv") return scheme;
  return scheme.split("+")[0];
}

export function parseDsn(input: string): ParseResult {
  const text = input.trim();
  const match = text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s);
  if (!match) return { ok: false, error: "Not a connection URL: expected scheme://… (for example postgresql://user:pass@host:5432/db)." };
  const rawScheme = match[1].toLowerCase();
  const kind = SCHEME_TO_KIND[baseScheme(rawScheme)];
  if (!kind) return { ok: false, error: `Unsupported scheme "${rawScheme}". Supported: ${Object.keys(SCHEME_TO_KIND).join(", ")}.` };
  const info = kindInfo(kind);
  const notes: string[] = [];
  if (baseScheme(rawScheme) !== rawScheme && rawScheme !== "mongodb+srv") notes.push(`Driver suffix "+${rawScheme.split("+")[1]}" was dropped; it is a client-library choice, not part of the database address.`);

  let rest = match[2];
  let params = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    notes.push("The #fragment was ignored: databases do not use it.");
    rest = rest.slice(0, hash);
  }
  const q = rest.indexOf("?");
  if (q >= 0) {
    params = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }

  const fields = emptyFields(kind);
  fields.params = params;

  if (info.file) {
    // sqlite:///relative.db  ·  sqlite:////absolute.db  ·  sqlite:///:memory:
    fields.database = rest.startsWith("/") ? rest.slice(1) : rest;
    return { ok: true, fields, notes };
  }

  const slash = rest.indexOf("/");
  let authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash + 1) : "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    authority = authority.slice(at + 1);
    const colon = userinfo.indexOf(":");
    const user = decode(colon >= 0 ? userinfo.slice(0, colon) : userinfo);
    const pass = decode(colon >= 0 ? userinfo.slice(colon + 1) : "");
    if (user.bad || pass.bad) {
      return { ok: false, error: "User or password contains a stray % that is not a valid percent-escape. Encode a literal % as %25." };
    }
    fields.user = user.text;
    fields.password = pass.text;
  }

  if (info.multiHost || info.noPort) {
    fields.host = authority;
    fields.port = "";
  } else {
    const ipv6 = authority.match(/^(\[[^\]]+\])(?::(\d*))?$/);
    const plain = authority.match(/^(.*?)(?::(\d*))?$/);
    const parts = ipv6 ?? plain;
    fields.host = parts?.[1] ?? authority;
    fields.port = parts?.[2] ?? "";
  }
  const dbPart = decode(path);
  if (dbPart.bad) return { ok: false, error: "The database path contains an invalid percent-escape." };
  fields.database = dbPart.text;
  if (!fields.host) notes.push("No host found in the URL.");
  return { ok: true, fields, notes };
}

export interface DsnProblem {
  field: "host" | "port" | "database" | "general";
  message: string;
}

export function validateFields(fields: DsnFields): DsnProblem[] {
  const info = kindInfo(fields.kind);
  const problems: DsnProblem[] = [];
  if (info.file) {
    if (!fields.database.trim()) problems.push({ field: "database", message: "Enter the SQLite file path (or :memory:)." });
    return problems;
  }
  if (!fields.host.trim()) problems.push({ field: "host", message: "Enter a host name or IP address." });
  if (!info.noPort && !info.multiHost && fields.port.trim()) {
    const port = Number(fields.port);
    if (!/^\d+$/.test(fields.port.trim()) || port < 1 || port > 65535) problems.push({ field: "port", message: "Port must be a whole number from 1 to 65535." });
  }
  if (/\s/.test(fields.host.trim())) problems.push({ field: "host", message: "Host must not contain spaces." });
  if ((fields.kind === "redis" || fields.kind === "rediss") && fields.database && !/^\d+$/.test(fields.database)) {
    problems.push({ field: "database", message: "Redis database must be a number such as 0." });
  }
  return problems;
}
