// Postgres backend of scripts/accounts.mjs (KNIFE_DB_URL set; docs/DB-POSTGRES.md "Accounts CLI"). The CLI keeps its
// commands and its file-format records; this module loads them from knife_load_core() and writes the changed ones back
// through knife_apply_core() with optimistic versions (a row the server changed meanwhile fails the command: run it
// again), which also NOTIFYs the running server so it reloads. Plain .mjs, `pg` only.
import { hostname } from "node:os";
import { pgConfig } from "../src/lib/db/connect.mjs";

export async function openCorePg(env = process.env) {
  const { default: pg } = await import("pg");
  const client = new pg.Client(pgConfig(env, { applicationName: "samurai-knife-accounts-cli" }));
  await client.connect();
  const origin = `cli:${hostname()}:${process.pid}`;
  // The running server reloads after our NOTIFY and answers on knife_core_ack with our origin: a command returns only
  // once its change is visible to the server's next request (as with the file store, where the server re-reads the file).
  const acks = [];
  client.on("notification", (message) => {
    if (message.channel === "knife_core_ack" && message.payload === origin) for (const resolve of acks.splice(0)) resolve(true);
  });
  await client.query("LISTEN knife_core_ack");
  const WRITER_LOCK = 7355608002; // src/lib/db/core/init.ts
  const serverSeen = async () => {
    const acked = new Promise((resolve) => {
      acks.push(resolve);
      setTimeout(() => resolve(false), Number(env.KNIFE_DB_ACK_TIMEOUT_MS) || 5_000).unref();
    });
    // No server holds the writer lock: nobody to wait for. (pg_locks, read only: never takes the lock itself, so a
    // server starting at this moment is not refused.) A bigint advisory key shows as classid = high, objid = low 32 bits.
    const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND classid = ($1::bigint >> 32)::oid AND objid = ($1::bigint & 4294967295)::oid AND objsubid = 1) AS held`, [WRITER_LOCK]);
    if (!rows[0].held) {
      for (const resolve of acks.splice(0)) resolve(true);
      return;
    }
    if (!(await acked)) console.error("warning: the running server has not confirmed it reloaded the change yet (it will on its next idle moment)");
  };
  let versions = new Map();
  let loadedPlain = new Map();
  let loadedDefault = null;
  let keys = [];

  const plain = (account) => JSON.stringify(account);
  return {
    /** The store in the accounts.json shape (secrets still sealed; the CLI opens them as for the file). */
    async load() {
      const { rows } = await client.query("SELECT knife_load_core() AS core");
      const core = rows[0].core;
      versions = new Map(core.accounts.map((row) => [row.doc.id, row.version]));
      loadedDefault = core.defaultAccountId;
      keys = core.keys;
      return { version: 2, defaultAccountId: core.defaultAccountId ?? "genor", accounts: core.accounts.map((row) => row.doc), empty: core.accounts.length === 0 };
    },
    /** Remembers the opened records as loaded, so `save` sends only what a command changed. */
    remember(accounts) {
      loadedPlain = new Map(accounts.map((account) => [account.id, plain(account)]));
    },
    /** `opened` = the store as the command left it (secrets open), `sealedById` = the same records sealed. */
    async save(store, opened, sealedById) {
      const upsert = [];
      const remove = [];
      for (const account of opened) {
        if (loadedPlain.get(account.id) === plain(account)) continue;
        upsert.push({ doc: sealedById.get(account.id), expect: versions.get(account.id) ?? null });
      }
      const ids = new Set(opened.map((account) => account.id));
      for (const id of loadedPlain.keys()) if (!ids.has(id) && versions.has(id)) remove.push({ id, expect: versions.get(id) });
      const batch = { origin };
      if (upsert.length || remove.length) batch.accounts = { upsert, delete: remove };
      if (store.defaultAccountId !== loadedDefault) batch.defaultAccountId = store.defaultAccountId;
      if (!batch.accounts && batch.defaultAccountId === undefined) return;
      try {
        const { rows } = await client.query("SELECT knife_apply_core($1::jsonb) AS result", [JSON.stringify(batch)]);
        for (const [id, version] of Object.entries(rows[0].result.versions)) versions.set(id, version);
        await serverSeen();
      } catch (error) {
        if (error?.code === "40001") throw new Error("an account changed in the database while this command ran (the server wrote it); run the command again");
        throw error;
      }
      for (const { id } of remove) versions.delete(id);
      loadedDefault = store.defaultAccountId;
      loadedPlain = new Map(opened.map((account) => [account.id, plain(account)]));
    },
    /** Revokes every MCP key of an account; returns how many it had. */
    async revokeKeys(accountId) {
      const doomed = keys.filter((key) => key.accountId === accountId).map((key) => key.id);
      if (!doomed.length) return 0;
      await client.query("SELECT knife_apply_core($1::jsonb)", [JSON.stringify({ origin, keys: { delete: doomed } })]);
      await serverSeen();
      keys = keys.filter((key) => key.accountId !== accountId);
      return doomed.length;
    },
    close: () => client.end(),
  };
}
