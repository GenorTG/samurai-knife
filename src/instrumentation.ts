/**
 * Runs once per server start (Next instrumentation). Node runtime only: starts the admin alert digest
 * (src/lib/security/alerts.ts; public mode only, a no-op otherwise) and the sidecar idle stop + autostart loop
 * (src/lib/services/autostart.ts; a no-op without installed autostart sidecars).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSecurityAlerts } = await import("@/lib/security/alerts");
  startSecurityAlerts();
  const { startSidecarAutostart } = await import("@/lib/services/autostart");
  startSidecarAutostart();
}
