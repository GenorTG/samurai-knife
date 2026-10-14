"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { organize } from "@/lib/markdown-organize";

const SAMPLE = `# Project notes\n\n### Overview\nA short summary.\n\n* First item\n+ Second item\n\n### Next steps\n1. Start\n1. Finish`;

export default function MarkdownOrganizer() {
  const [input, setInput] = useState(SAMPLE);
  const [addToc, setAddToc] = useState(true);
  const output = useMemo(() => organize(input, addToc), [addToc, input]);
  const headingCount = (output.match(/^#{1,6}\s/gm) ?? []).length;
  const listCount = (output.match(/^\s*(?:[-*+] |\d+[.)] )/gm) ?? []).length;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Markdown source" right={<Button size="sm" onClick={() => setInput(SAMPLE)}>Sample</Button>}>
        <div className="space-y-3">
          <TextArea rows={23} spellCheck={false} value={input} onChange={(event) => setInput(event.target.value)} placeholder="# Paste a Markdown document…" />
          <Field label="Table of contents">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={addToc} onChange={(event) => setAddToc(event.target.checked)} />
              Insert or regenerate a Contents section after the title
            </label>
          </Field>
          <Notice>Repairs heading-level jumps, normalizes unordered list markers, renumbers ordered lists, and trims excess blank lines. Fenced and indented code is kept intact.</Notice>
        </div>
      </Panel>
      <Panel
        title="Organized Markdown"
        right={<div className="flex gap-1.5"><CopyButton text={output} /><Button size="sm" disabled={!output} onClick={() => downloadText(output, "organized.md", "text/markdown")}>Save .md</Button></div>}
      >
        <div className="space-y-3">
          <StatGrid><Stat label="Headings" value={headingCount} /><Stat label="List items" value={listCount} /></StatGrid>
          <TextArea readOnly rows={23} value={output} placeholder="Organized Markdown appears here…" />
        </div>
      </Panel>
    </div>
  );
}
