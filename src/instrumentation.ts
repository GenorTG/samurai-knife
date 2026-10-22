/**
 * Runs once per server start (Next instrumentation). Node runtime only: starts the admin alert digest
 * (src/lib/security/alerts.ts; public mode only, a no-op otherwise) and the sidecar idle stop + autostart loop
 * (src/lib/services/autostart.ts; a no-op without installed autostart sidecars), and the daily Craft apps update check
 * (src/lib/craft/updates.ts; a no-op while the sidecar is not installed or its update mode is off), and the workflow
 * scheduler (src/lib/workflows/server/scheduler.ts: schedule triggers, timed resumes; KNIFE_WF_SCHEDULER=off disables it).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSecurityAlerts } = await import("@/lib/security/alerts");
  startSecurityAlerts();
  const { startSidecarAutostart } = await import("@/lib/services/autostart");
  startSidecarAutostart();
  const { startCraftUpdater } = await import("@/lib/craft/updates");
  startCraftUpdater();
  const { startWorkflowScheduler } = await import("@/lib/workflows/server/scheduler");
  startWorkflowScheduler();
}
