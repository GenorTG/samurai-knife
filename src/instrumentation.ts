/**
 * Runs once per server start (Next instrumentation). Node runtime only: loads the Postgres core store when KNIFE_DB_URL
 * is set (src/lib/db/core/init.ts), then starts the admin alert digest
 * (src/lib/security/alerts.ts; public mode only, a no-op otherwise) and the sidecar idle stop + autostart loop
 * (src/lib/services/autostart.ts; a no-op without installed autostart sidecars), the root-bundle "sync needed" check
 * (src/lib/services/sync-check.ts; helper backend only), and the daily Craft apps update check
 * (src/lib/craft/updates.ts; a no-op while the sidecar is not installed or its update mode is off), and the workflow
 * scheduler (src/lib/workflows/server/scheduler.ts: schedule triggers, timed resumes; KNIFE_WF_SCHEDULER=off disables it).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // KNIFE_DB_URL: the core store (accounts, sessions, MCP keys) lives in Postgres and is loaded before the first request
  // (src/lib/db/core/init.ts, docs/DB-POSTGRES.md). A server that cannot load it, or finds another writer, must not serve.
  if (process.env.KNIFE_DB_URL?.trim()) {
    const { initCoreStorageOrExit } = await import("@/lib/db/core/init");
    await initCoreStorageOrExit();
  }
  const { startSecurityAlerts } = await import("@/lib/security/alerts");
  startSecurityAlerts();
  const { startSidecarAutostart } = await import("@/lib/services/autostart");
  startSidecarAutostart();
  const { startSyncChecks } = await import("@/lib/services/sync-check");
  startSyncChecks();
  const { startCraftUpdater } = await import("@/lib/craft/updates");
  startCraftUpdater();
  const { startWorkflowScheduler } = await import("@/lib/workflows/server/scheduler");
  startWorkflowScheduler();
}
