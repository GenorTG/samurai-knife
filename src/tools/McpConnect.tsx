"use client";

import { useMemo, useSyncExternalStore } from "react";
import { CopyButton, Notice, Panel } from "@/components/ui";
import { useT } from "@/lib/i18n/react";

const subscribeToOrigin = () => () => {};
const getOriginSnapshot = () => window.location.origin;
const getServerOriginSnapshot = () => "";

export default function McpConnect() {
  const { t } = useT();
  const siteOrigin = useSyncExternalStore(subscribeToOrigin, getOriginSnapshot, getServerOriginSnapshot);
  const endpoint = siteOrigin ? `${siteOrigin}/api/mcp` : "";
  const mcpConfig = useMemo(
    () => (siteOrigin ? JSON.stringify({ mcpServers: { "samurai-knife": { url: endpoint } } }, null, 2) : ""),
    [siteOrigin, endpoint],
  );

  return (
    <div className="space-y-4">
      <Panel title={t("MCP setup for URL-based agents")}>
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-muted">
            {t("Use this Cursor-style")}{" "} <code>mcpServers</code> {" "}{t("URL config (also supported by other Streamable HTTP clients) to let an external agent call Smart Knife's deterministic tools. The endpoint is computed from this page's current origin; the agent must be able to reach that host.")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-raised/50 px-3 py-2 font-mono text-xs text-ink">
              {endpoint || t("Detecting site address…")}
            </code>
            <CopyButton text={endpoint} label={t("Copy endpoint")} />
          </div>
          <div className="flex justify-end"><CopyButton text={mcpConfig} label={t("Copy MCP config")} /></div>
          <pre className="overflow-x-auto rounded-lg border border-line bg-raised/50 p-3 font-mono text-xs leading-relaxed text-ink">{mcpConfig || t("Preparing configuration…")}</pre>
          <Notice>
            {t("This config contains no credentials. Only devices on this machine's Tailscale network can reach the service; use tailnet ACLs to control device access.")}
          </Notice>
        </div>
      </Panel>
      <Panel title={t("Built-in assistant")}>
        <p className="text-sm leading-relaxed text-muted">
          {t("The chat widget in the bottom-right corner is the built-in assistant. Each account configures its own provider (endpoint, key and model) in the widget settings; keys are stored on the server and never sent to the browser.")}
        </p>
      </Panel>
    </div>
  );
}
