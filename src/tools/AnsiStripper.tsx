"use client";

import { useMemo, useState } from "react";
import { CopyButton, Field, Panel, Stat, StatGrid, TextArea } from "@/components/ui";

const ANSI_CONTROL = /(?:\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[P^_X][^\u001B]*\u001B\\|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-_]|\u009B[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F\u0080-\u009A\u009C-\u009F])/g;

export default function AnsiStripper() {
  const [input, setInput] = useState("\u001b[32m✓ build passed\u001b[0m\n\u001b[31m✗ test failed\u001b[0m");
  const output = useMemo(() => input.replace(ANSI_CONTROL, ""), [input]);
  return <Panel title="ANSI escape stripper" right={<CopyButton text={output} label="Copy clean text" />}>
    <div className="space-y-3">
      <Field label="Terminal output"><TextArea rows={12} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
      <StatGrid><Stat label="Input characters" value={input.length} /><Stat label="Removed control characters" value={input.length - output.length} /></StatGrid>
      <Field label="Clean output"><TextArea rows={12} readOnly value={output} /></Field>
      <p className="text-xs text-faint">Strips common ANSI/ECMA-48 CSI, OSC, and C0/C1 controls. It does not execute terminal escape sequences.</p>
    </div>
  </Panel>;
}
