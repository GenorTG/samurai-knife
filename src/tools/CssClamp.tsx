"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, NumberField, Panel, Stat, StatGrid } from "@/components/ui";
import { useT } from "@/lib/i18n/react";

export default function CssClamp() {
  const { t } = useT();
  const [minValue, setMinValue] = useState(16);
  const [maxValue, setMaxValue] = useState(32);
  const [minWidth, setMinWidth] = useState(360);
  const [maxWidth, setMaxWidth] = useState(1440);
  const result = useMemo(() => {
    const range = Math.max(1, maxWidth - minWidth);
    const slope = (maxValue - minValue) / range * 100;
    const intercept = minValue - slope * minWidth / 100;
    const value = `clamp(${minValue}px, ${intercept.toFixed(2)}px + ${slope.toFixed(3)}vw, ${maxValue}px)`;
    return { value, slope };
  }, [maxValue, maxWidth, minValue, minWidth]);
  const declaration = `font-size: ${result.value};`;
  return <Panel title={t("Fluid CSS clamp()")} right={<CopyButton text={declaration} label={t("Copy CSS")} />}>
    <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">{[[t("Minimum size (px)"), minValue, setMinValue], [t("Maximum size (px)"), maxValue, setMaxValue], [t("Minimum viewport (px)"), minWidth, setMinWidth], [t("Maximum viewport (px)"), maxWidth, setMaxWidth]].map(([label, value, setter]) => <Field key={String(label)} label={String(label)}><NumberField min={1} max={Infinity} value={Number(value)} onValueChange={setter as (value: number) => void} /></Field>)}</div>
      <StatGrid><Stat label={t("Generated value")} value={<code className="break-all">{result.value}</code>} /><Stat label={t("Fluid slope")} value={`${result.slope.toFixed(3)}vw`} /></StatGrid>
      <div className="rounded-lg border border-line bg-raised p-5 text-center" style={{ fontSize: result.value }}>{t("Fluid type preview")}</div>
      <p className="text-xs text-faint">{t("Linear interpolation between the two supplied viewport widths; outside that interval the minimum or maximum applies.")}</p>
    </div>
  </Panel>;
}
