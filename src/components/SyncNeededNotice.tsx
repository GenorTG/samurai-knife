"use client";

import { CopyButton } from "@/components/ui";
import { useT } from "@/lib/i18n/react";

/**
 * "Sync needed" for one sidecar (src/lib/services/sync-check.ts): root's installed bundle differs from what this release
 * renders, so the sidecar cannot start until the owner runs the sync on the host. Shown to admins on the Sidecar
 * services page and on /account/admin. The app never runs the sync itself (it needs root on purpose).
 */
export function SyncNeededNotice({ id, name, message }: { id: string; name: string; message?: string }) {
  const { t, m } = useT();
  const commands = `sudo knife-sidecar check ${id}\nsudo knife-sidecar sync ${id}`;
  return (
    <div data-sync-needed={id} role="alert" className="space-y-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-[13px] leading-relaxed text-warn">
      {/* The server's message already starts with "Sync needed" and names the sidecar: it is the headline when there is one. */}
      <p className="font-semibold">{message ? m(message) : t("Sync needed: {name}", { name })}</p>
      <p>{t("It keeps running until it stops, but it cannot start again until this is done. On the host, as root (the first command shows what differs, the second installs it):")}</p>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink">{commands}</pre>
        <CopyButton text={commands} />
      </div>
    </div>
  );
}
