// Throwaway Postgres 18 for tests (docs/DB-POSTGRES.md "Tests"): one Docker container per run, named sk-pg-test-<pid>-<hex>,
// published on 127.0.0.1 at a port from KNIFE_SCRATCH_PORTS (default 3401-3449), anonymous volume removed with it.
// Never touches another container (the learn-db sidecar and every other project keep running). Skips cleanly when
// Docker is missing: `available()` says why.
//
//   const pg = await startScratchPostgres(); const url = await pg.database("t1"); ... await pg.stop();
//   node tests/pg_scratch.mjs up      -> prints {"name","port","url"}; the container keeps running
//   node tests/pg_scratch.mjs down <name>
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

const IMAGE = process.env.KNIFE_TEST_PG_IMAGE || "postgres:18";
const USER = "knife";
const PASSWORD = "knife-test-only";

export function available() {
  const probe = spawnSync("docker", ["image", "inspect", IMAGE], { encoding: "utf8" });
  if (probe.error) return { ok: false, reason: "docker is not installed" };
  if (probe.status !== 0) return { ok: false, reason: `image ${IMAGE} is not pulled (docker pull ${IMAGE})` };
  return { ok: true, reason: "" };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function freeScratchPort(skip = new Set()) {
  const [low, high] = (process.env.KNIFE_SCRATCH_PORTS || "3401-3449").split("-").map(Number);
  for (let port = low; port <= (high || low); port += 1) {
    if (!skip.has(port) && (await portFree(port))) return port;
  }
  throw new Error(`no free port in KNIFE_SCRATCH_PORTS=${process.env.KNIFE_SCRATCH_PORTS || "3401-3449"}`);
}

const urlFor = (port, db) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${db}`;

export async function startScratchPostgres({ port } = {}) {
  const check = available();
  if (!check.ok) throw new Error(check.reason);
  const hostPort = port ?? (await freeScratchPort());
  const name = `sk-pg-test-${process.pid}-${randomBytes(3).toString("hex")}`;
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name, "--label", "samurai-knife.test=1",
    "-e", `POSTGRES_USER=${USER}`, "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_DB=knife",
    "-p", `127.0.0.1:${hostPort}:5432`, IMAGE,
    // Small-VPS-like settings (deploy/db/postgresql.knife.conf); durability stays on.
    "-c", "shared_buffers=128MB", "-c", "max_connections=30", "-c", "synchronous_commit=on",
  ], { stdio: "ignore" });
  const stop = () => {
    spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
  };
  const deadline = Date.now() + 60_000;
  const { default: pg } = await import("pg");
  for (;;) {
    const client = new pg.Client({ connectionString: urlFor(hostPort, "knife") });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      break;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (Date.now() > deadline) {
        stop();
        throw new Error(`scratch Postgres did not start: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  return {
    name,
    port: hostPort,
    url: urlFor(hostPort, "knife"),
    urlFor: (db) => urlFor(hostPort, db),
    /** A fresh empty database; returns its URL. */
    async database(db) {
      const admin = new pg.Client({ connectionString: urlFor(hostPort, "knife") });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
        await admin.query(`CREATE DATABASE "${db}"`);
      } finally {
        await admin.end();
      }
      return urlFor(hostPort, db);
    },
    stop,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, name] = process.argv.slice(2);
  if (command === "up") {
    const pg = await startScratchPostgres();
    console.log(JSON.stringify({ name: pg.name, port: pg.port, url: pg.url }));
  } else if (command === "newdb") {
    // newdb <admin url> <database> : a fresh, migrated database; prints the URL the app should use (through
    // KNIFE_TEST_PG_VIA=host:port, the latency proxy, when set). Used by tests/scratch_server.py per server start.
    const [admin, db] = process.argv.slice(3);
    if (!admin || !/^[a-z0-9_]{1,60}$/.test(db ?? "")) {
      console.error("usage: node tests/pg_scratch.mjs newdb <admin-url> <database>");
      process.exit(2);
    }
    const { default: pg } = await import("pg");
    const { migrate } = await import("../scripts/db-migrate.mjs");
    const adminClient = new pg.Client({ connectionString: admin });
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE "${db}"`);
    await adminClient.end();
    const url = new URL(admin);
    url.pathname = `/${db}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await migrate(client, { log: () => undefined });
    await client.end();
    const via = process.env.KNIFE_TEST_PG_VIA?.trim();
    if (via) {
      const [host, port] = via.split(":");
      url.hostname = host;
      url.port = port;
    }
    console.log(url.toString());
  } else if (command === "down" && name?.startsWith("sk-pg-test-")) {
    spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
  } else {
    console.error("usage: node tests/pg_scratch.mjs up | down <sk-pg-test-…>");
    process.exit(2);
  }
}
