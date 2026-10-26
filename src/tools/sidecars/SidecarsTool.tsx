"use client";

import Link from "next/link";
import { SIDECARS } from "@/lib/services/definitions";
import { findTool } from "@/lib/registry";
import { SidecarCard } from "./SidecarCard";
import { useSidecar } from "./useSidecar";
import { useT } from "@/lib/i18n/react";

function ServiceSection({ id, usedBy }: { id: string; usedBy: string[] }) {
  const { t } = useT();
  const sidecar = useSidecar(id);
  return (
    <SidecarCard
      sidecar={sidecar}
      intro={
        <p className="text-sm text-muted">
          {t("Used by:")}{" "}
          {usedBy.map((slug, i) => (
            <span key={slug}>
              {i ? ", " : ""}
              <Link className="text-accent-soft underline underline-offset-2" href={`/tools/${slug}`}>
                {t(findTool(slug)?.name ?? slug)}
              </Link>
            </span>
          ))}
        </p>
      }
    />
  );
}

/** Settings page for the optional docker services ("sidecars"). Same operations as `npm run services`. */
export default function SidecarsTool() {
  const { t } = useT();
  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">
        {t("Sidecars are optional docker compose services some tools need. Each one is installed, started and stopped from here (or with")}{" "} <code className="font-mono text-[13px]">npm run services</code>{t("), starts by itself when a tool needs it, and stops after its idle time, unless it is set to start automatically (then it runs from app start and comes back within a minute if it stops). Removing keeps its data volumes unless you choose otherwise.")}
      </p>
      {SIDECARS.map((def) => (
        <ServiceSection key={def.id} id={def.id} usedBy={def.usedBy} />
      ))}
    </div>
  );
}
