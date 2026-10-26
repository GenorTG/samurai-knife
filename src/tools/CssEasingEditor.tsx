"use client";

import { useState } from "react";
import { CopyButton, Field, NumberField, Panel } from "@/components/ui";
import { useT } from "@/lib/i18n/react";

export default function CssEasingEditor() {
  const { t } = useT();
  const [points, setPoints] = useState([0.25, 0.1, 0.25, 1]);
  const [playing, setPlaying] = useState(false);
  const easing = `cubic-bezier(${points.map((point) => point.toFixed(2)).join(", ")})`;
  const css = `transition-timing-function: ${easing};`;
  const coords = `M 20 180 C ${20 + points[0] * 200} ${180 - points[1] * 160}, ${20 + points[2] * 200} ${180 - points[3] * 160}, 220 20`;
  return <Panel title={t("CSS easing curve editor")} right={<CopyButton text={css} label={t("Copy CSS")} />}>
    <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">{points.map((point, index) => <Field key={index} label={t("Control point {value} {value2} ({value3})", { value: index < 2 ? "1" : "2", value2: index % 2 ? "Y" : "X", value3: index % 2 ? "overshoot allowed" : "0–1" })}><NumberField step="0.05" min={index % 2 ? -2 : 0} max={index % 2 ? 2 : 1} fallback={0} value={point} onValueChange={(value) => setPoints((old) => old.map((item, i) => i === index ? value : item))} /></Field>)}</div>
      <svg viewBox="0 0 240 200" role="img" aria-label={t("Cubic Bezier easing curve")} className="h-56 w-full rounded-lg border border-line bg-raised"><path d="M 20 20 V 180 H 220" fill="none" stroke="currentColor" opacity=".25" /><path d={coords} fill="none" stroke="currentColor" strokeWidth="3" /><circle cx={20 + points[0] * 200} cy={180 - points[1] * 160} r="5" fill="currentColor" /><circle cx={20 + points[2] * 200} cy={180 - points[3] * 160} r="5" fill="currentColor" /></svg>
      <div className="flex items-center gap-3"><button autoComplete="off" type="button" className="rounded-lg border border-line px-3 py-2 text-sm" onClick={() => setPlaying((value) => !value)}>{playing ? t("Reset preview") : t("Play preview")}</button><div className="relative h-10 flex-1 overflow-hidden rounded border border-line bg-raised"><div className="absolute top-2 h-6 w-6 rounded-full bg-accent" style={{ left: playing ? "calc(100% - 2rem)" : "0.5rem", transition: `left 1200ms ${easing}` }} /></div></div>
      <code className="block rounded-lg border border-line bg-raised p-3 text-sm">{css}</code>
    </div>
  </Panel>;
}
