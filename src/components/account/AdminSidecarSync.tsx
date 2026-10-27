"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SyncNeededNotice } from "@/components/SyncNeededNotice";
import { useT } from "@/lib/i18n/react";
import { call } from "./api";

interface SidecarsReply {
  backend: string;
  syncNeeded: { id: string; name: string; reason?: string; message?: string; command: string; checkedAt: string }[];
}

/**
 * /account/admin: sidecars whose root-installed bundle no longer matches this release (GET /api/admin/sidecars). Renders
 * nothing when every sidecar is in sync, so it only appears when the owner has something to do.
 */
export function AdminSidecarSync() {
  const { t } = useT();
  const [data, setData] = useState<SidecarsReply | null>(null);
  useEffect(() => {
    void call<SidecarsReply>("GET", "/api/admin/sidecars").then((reply) => {
      if (reply.ok) setData(reply.body);
    });
  }, []);
  if (!data?.syncNeeded.length) return null;
  return (
    <section aria-label={t("Sidecars that need a sync")} className="space-y-2">
      {data.syncNeeded.map((item) => (
        <SyncNeededNotice key={item.id} id={item.id} name={item.name} message={item.message} />
      ))}
      <p className="text-[13px] text-muted">
        <Link className="text-accent-soft underline underline-offset-2" href="/tools/sidecars">{t("Sidecar services")}</Link>
      </p>
    </section>
  );
}
