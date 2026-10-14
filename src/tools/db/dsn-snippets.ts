import { enc, kindInfo, PASSWORD_MASK, type DsnFields } from "@/lib/sql/dsn";

export interface Snippet {
  label: string;
  language: string;
  code: string;
}

/** Single-quote a value for POSIX shells. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const str = (value: string) => JSON.stringify(value);

/**
 * Client snippets for the chosen database. `url` is the already-built (maybe masked) URL; `secret` is the password
 * as it should appear in code samples (masked unless the user revealed it).
 */
export function buildSnippets(fields: DsnFields, url: string, reveal: boolean): Snippet[] {
  const info = kindInfo(fields.kind);
  const secret = fields.password ? (reveal ? fields.password : PASSWORD_MASK) : "";
  const host = fields.host.trim() || "localhost";
  const port = fields.port.trim() || info.defaultPort;
  const db = fields.database;
  const user = fields.user;
  const jdbcQuery = (pairs: [string, string][]) =>
    pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join("&");
  const urlWithScheme = (scheme: string) => url.replace(/^[a-z0-9+.-]+:\/\//i, `${scheme}://`);

  switch (fields.kind) {
    case "postgres":
      return [
        { label: "psql", language: "bash", code: `psql ${shellQuote(url)}` },
        { label: "Python (psycopg 3)", language: "python", code: `import psycopg\n\nwith psycopg.connect(${str(url)}) as conn:\n    print(conn.execute("select version()").fetchone())` },
        { label: "SQLAlchemy", language: "python", code: `from sqlalchemy import create_engine\n\nengine = create_engine(${str(urlWithScheme("postgresql+psycopg"))})` },
        { label: "Node (pg)", language: "javascript", code: `import { Pool } from "pg";\n\nconst pool = new Pool({ connectionString: ${str(url)} });\nconsole.log((await pool.query("select now()")).rows);` },
        { label: "Prisma", language: "prisma", code: `datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}` },
        { label: "JDBC", language: "text", code: `jdbc:postgresql://${host}:${port}/${enc(db)}?${jdbcQuery([["user", user], ["password", secret], ...paramPairs(fields.params)])}` },
      ];
    case "mysql":
    case "mariadb":
      return [
        { label: "mysql CLI", language: "bash", code: `mysql -h ${shellQuote(host)} -P ${port} -u ${shellQuote(user)} -p ${shellQuote(db)}` },
        { label: "SQLAlchemy (PyMySQL)", language: "python", code: `from sqlalchemy import create_engine\n\nengine = create_engine(${str(urlWithScheme("mysql+pymysql"))})` },
        { label: "Node (mysql2)", language: "javascript", code: `import mysql from "mysql2/promise";\n\nconst conn = await mysql.createConnection(${str(urlWithScheme("mysql"))});\nconsole.log(await conn.query("select version()"));` },
        { label: "Prisma", language: "prisma", code: `datasource db {\n  provider = "mysql"\n  url      = env("DATABASE_URL")\n}` },
        { label: "JDBC", language: "text", code: `jdbc:${fields.kind === "mariadb" ? "mariadb" : "mysql"}://${host}:${port}/${enc(db)}?${jdbcQuery([["user", user], ["password", secret], ...paramPairs(fields.params)])}` },
      ];
    case "sqlite":
      return [
        { label: "sqlite3 CLI", language: "bash", code: `sqlite3 ${shellQuote(db)}` },
        { label: "Python (sqlite3)", language: "python", code: `import sqlite3\n\nconn = sqlite3.connect(${str(db)})\nprint(conn.execute("select sqlite_version()").fetchone())` },
        { label: "SQLAlchemy", language: "python", code: `from sqlalchemy import create_engine\n\nengine = create_engine(${str(url)})` },
        { label: "Node (better-sqlite3)", language: "javascript", code: `import Database from "better-sqlite3";\n\nconst db = new Database(${str(db)});\nconsole.log(db.prepare("select sqlite_version()").get());` },
        { label: "Prisma", language: "prisma", code: `datasource db {\n  provider = "sqlite"\n  url      = "file:${db}"\n}` },
      ];
    case "sqlserver":
      return [
        { label: "sqlcmd", language: "bash", code: `sqlcmd -S ${shellQuote(`${host},${port}`)} -U ${shellQuote(user)} -P ${shellQuote(secret)} -d ${shellQuote(db)}` },
        { label: "SQLAlchemy (pyodbc)", language: "python", code: `from sqlalchemy import create_engine\n\nengine = create_engine(\n    ${str(`mssql+pyodbc://${enc(user)}:${fields.password ? (reveal ? enc(fields.password) : PASSWORD_MASK) : ""}@${host}:${port}/${enc(db)}?driver=ODBC+Driver+18+for+SQL+Server`)}\n)` },
        { label: "Node (mssql)", language: "javascript", code: `import sql from "mssql";\n\nawait sql.connect({ server: ${str(host)}, port: ${port}, user: ${str(user)}, password: ${str(secret)}, database: ${str(db)}, options: { encrypt: true } });` },
        { label: "JDBC", language: "text", code: `jdbc:sqlserver://${host}:${port};databaseName=${db};user=${user};password={${secret.replace(/}/g, "}}")};encrypt=true` },
      ];
    case "oracle":
      return [
        { label: "sqlplus", language: "bash", code: `sqlplus ${shellQuote(`${user}/${secret}@//${host}:${port}/${db}`)}` },
        { label: "Python (python-oracledb)", language: "python", code: `import oracledb\n\nconn = oracledb.connect(user=${str(user)}, password=${str(secret)}, dsn=${str(`${host}:${port}/${db}`)})\nprint(conn.version)` },
        { label: "SQLAlchemy", language: "python", code: `from sqlalchemy import create_engine\n\nengine = create_engine(${str(`oracle+oracledb://${enc(user)}:${fields.password ? (reveal ? enc(fields.password) : PASSWORD_MASK) : ""}@${host}:${port}/?service_name=${enc(db)}`)})` },
        { label: "JDBC", language: "text", code: `jdbc:oracle:thin:@//${host}:${port}/${db}` },
      ];
    case "mongodb":
    case "mongodb-srv":
      return [
        { label: "mongosh", language: "bash", code: `mongosh ${shellQuote(url)}` },
        { label: "Python (pymongo)", language: "python", code: `from pymongo import MongoClient\n\nclient = MongoClient(${str(url)})\nprint(client.list_database_names())` },
        { label: "Node (mongodb)", language: "javascript", code: `import { MongoClient } from "mongodb";\n\nconst client = new MongoClient(${str(url)});\nawait client.connect();\nconsole.log(await client.db().command({ ping: 1 }));` },
      ];
    case "redis":
    case "rediss":
      return [
        { label: "redis-cli", language: "bash", code: `redis-cli -u ${shellQuote(url)}` },
        { label: "Python (redis-py)", language: "python", code: `import redis\n\nr = redis.Redis.from_url(${str(url)})\nprint(r.ping())` },
        { label: "Node (ioredis)", language: "javascript", code: `import Redis from "ioredis";\n\nconst redis = new Redis(${str(url)});\nconsole.log(await redis.ping());` },
      ];
    case "clickhouse":
      return [
        { label: "clickhouse-client", language: "bash", code: `clickhouse-client --host ${shellQuote(host)} --port 9000 --user ${shellQuote(user)} --password ${shellQuote(secret)} --database ${shellQuote(db)}` },
        { label: "Python (clickhouse-connect)", language: "python", code: `import clickhouse_connect\n\nclient = clickhouse_connect.get_client(host=${str(host)}, port=${port}, username=${str(user)}, password=${str(secret)}, database=${str(db || "default")})\nprint(client.query("select version()").result_rows)` },
        { label: "HTTP (curl)", language: "bash", code: `curl ${shellQuote(`http://${host}:${port}/?query=SELECT%201`)} --user ${shellQuote(`${user}:${secret}`)}` },
        { label: "JDBC", language: "text", code: `jdbc:clickhouse://${host}:${port}/${enc(db || "default")}` },
      ];
    case "chroma":
    case "chroma-tls": {
      const ssl = fields.kind === "chroma-tls";
      return [
        { label: "Heartbeat (curl)", language: "bash", code: `curl ${shellQuote(`${url.replace(/\/$/, "")}/api/v2/heartbeat`)}` },
        { label: "Python (chromadb)", language: "python", code: `import chromadb\n\nclient = chromadb.HttpClient(host=${str(host)}, port=${port}, ssl=${ssl ? "True" : "False"})\nprint(client.heartbeat())` },
        { label: "Node (chromadb)", language: "javascript", code: `import { ChromaClient } from "chromadb";\n\nconst client = new ChromaClient({ host: ${str(host)}, port: ${port}, ssl: ${ssl} });\nconsole.log(await client.heartbeat());` },
      ];
    }
  }
}

function paramPairs(params: string): [string, string][] {
  return params
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? [pair, ""] : [pair.slice(0, eq), decodeSafe(pair.slice(eq + 1))];
    });
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
