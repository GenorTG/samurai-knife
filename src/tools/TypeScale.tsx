"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, NumberField, Panel } from "@/components/ui";
import { useT } from "@/lib/i18n/react";
export default function TypeScale() {
  const { t } = useT();
  const [base, setBase] = useState(16), [ratio, setRatio] = useState(1.25);
  const sizes = useMemo(() => Array.from({ length: 8 }, (_, i) => ({ step: i - 2, px: base * ratio ** (i - 2) })), [base, ratio]);
  const css = sizes.map(({ step, px }) => `  --type-${step < 0 ? `minus-${Math.abs(step)}` : step}: ${px.toFixed(2)}px;`).join("\n");
  return <Panel title={t("Responsive type-scale previewer")} right={<CopyButton text={`:root {\n${css}\n}`} label={t("Copy CSS tokens")} />}><div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><Field label={t("Base size (px)")}><NumberField min={8} max={64} fallback={16} value={base} onValueChange={setBase} /></Field><Field label={t("Scale ratio")}><NumberField min={1.05} max={2} step={0.01} fallback={1.25} value={ratio} onValueChange={setRatio} /></Field></div>
    <div className="space-y-3">{sizes.slice().reverse().map(({ step, px }) => <div key={step} className="flex items-baseline justify-between gap-3 border-b border-line pb-2"><span className="min-w-0 break-words" style={{ fontSize: `${Math.min(px, 64)}px` }}>{t("Heading")}{" "} {step > 0 ? `+${step}` : step}</span><code className="shrink-0 text-xs text-faint">{px.toFixed(2)}px / {(px / 16).toFixed(3)}rem</code></div>)}</div><pre className="overflow-auto rounded-lg border border-line bg-raised p-3 text-sm">{`:root {\n${css}\n}`}</pre>
  </div></Panel>;
}
