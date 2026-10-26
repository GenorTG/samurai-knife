"use client";

import { useState } from "react";
import { CopyButton, Field, NumberField, Panel } from "@/components/ui";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const CORNERS = [msg("Top left"), msg("Top right"), msg("Bottom right"), msg("Bottom left")] as const;
export default function BorderRadiusBuilder() {
  const { t } = useT();
  const [radii, setRadii] = useState([24, 24, 24, 24]);
  const [elliptical, setElliptical] = useState(false);
  const [vertical, setVertical] = useState([24, 24, 24, 24]);
  const value = `${radii.join("% ")}%${elliptical ? ` / ${vertical.join("% ")}%` : ""}`;
  const css = `border-radius: ${value};`;
  return <Panel title={t("CSS border-radius builder")} right={<CopyButton text={css} label={t("Copy CSS")} />}>
    <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">{CORNERS.map((corner, index) => <Field key={corner} label={t("{corner} horizontal (%)", { corner })}><NumberField min={0} max={100} value={radii[index]} onValueChange={(v) => setRadii((old) => old.map((n, i) => i === index ? v : n))} /></Field>)}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={elliptical} onChange={(e) => setElliptical(e.target.checked)} /> {" "}{t("Use elliptical vertical radii")}</label>
      {elliptical && <div className="grid gap-3 sm:grid-cols-2">{CORNERS.map((corner, index) => <Field key={corner} label={t("{corner} vertical (%)", { corner })}><NumberField min={0} max={100} value={vertical[index]} onValueChange={(v) => setVertical((old) => old.map((n, i) => i === index ? v : n))} /></Field>)}</div>}
      <div className="grid min-h-48 place-items-center rounded-lg border border-line bg-raised"><div className="grid h-32 w-56 place-items-center bg-accent text-accent-fg" style={{ borderRadius: value }}>{t("Preview")}</div></div>
      <code className="block rounded-lg border border-line bg-raised p-3 text-sm">{css}</code>
    </div>
  </Panel>;
}
