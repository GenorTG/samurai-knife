"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, NumberField, Panel, Select, TextInput } from "@/components/ui";

/** Offsets and spread are free (the number input still bounds the spinner); blur cannot be negative and opacity is a percentage. */
const SHADOW_FIELDS = [
  { label: "X offset", min: -Infinity, max: Infinity },
  { label: "Y offset", min: -Infinity, max: Infinity },
  { label: "Blur", min: 0, max: Infinity },
  { label: "Spread", min: -Infinity, max: Infinity },
  { label: "Opacity (%)", min: 0, max: 100 },
] as const;
type ShadowLabel = (typeof SHADOW_FIELDS)[number]["label"];

export default function BoxShadowBuilder() {
  const [x, setX] = useState(0), [y, setY] = useState(12), [blur, setBlur] = useState(28), [spread, setSpread] = useState(0);
  const [color, setColor] = useState("#000000"), [colorDraft, setColorDraft] = useState("#000000"), [opacity, setOpacity] = useState(24), [inset, setInset] = useState(false);
  const rgba = useMemo(() => { const hex = color.replace("#", ""); const n = Number.parseInt(hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex, 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(opacity / 100).toFixed(2)})`; }, [color, opacity]);
  const values: Record<ShadowLabel, number> = { "X offset": x, "Y offset": y, Blur: blur, Spread: spread, "Opacity (%)": opacity };
  const setters: Record<ShadowLabel, (value: number) => void> = { "X offset": setX, "Y offset": setY, Blur: setBlur, Spread: setSpread, "Opacity (%)": setOpacity };
  const shadow = `${inset ? "inset " : ""}${x}px ${y}px ${blur}px ${spread}px ${rgba}`;
  const css = `box-shadow: ${shadow};`;
  return <Panel title="CSS box-shadow builder" right={<CopyButton text={css} label="Copy CSS" />}>
    <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">{SHADOW_FIELDS.map(({ label, min, max }) => <Field key={label} label={label}><NumberField min={min} max={max} fallback={0} value={values[label]} onValueChange={setters[label]} /></Field>)}
      <Field label="Shadow color"><div className="flex gap-2"><input aria-label="Shadow color" type="color" className="h-10 w-14 rounded border border-line bg-transparent" value={color} onChange={(e) => { setColor(e.target.value); setColorDraft(e.target.value); }} /><TextInput value={colorDraft} aria-label="Shadow color hex" spellCheck={false} onChange={(e) => { setColorDraft(e.target.value); if (/^#[\da-f]{6}$/i.test(e.target.value)) setColor(e.target.value.toLowerCase()); }} /></div></Field>
      <Field label="Placement"><Select value={inset ? "inset" : "outset"} onChange={(e) => setInset(e.target.value === "inset")}><option value="outset">Outside</option><option value="inset">Inset</option></Select></Field></div>
      <div className="grid min-h-48 place-items-center rounded-lg border border-line bg-raised"><div className="grid h-28 w-48 place-items-center rounded-xl bg-surface" style={{ boxShadow: shadow }}>Preview</div></div>
      <code className="block overflow-x-auto rounded-lg border border-line bg-raised p-3 text-sm">{css}</code>
    </div>
  </Panel>;
}
