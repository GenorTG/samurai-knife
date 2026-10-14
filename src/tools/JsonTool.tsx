"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, Notice, OutputBlock, Panel, Select, Stat, StatGrid, TextArea, WorkStatus } from "@/components/ui";
import { downloadText, formatInt } from "@/lib/format";
import { JSON_DISPLAY_LIMIT, JSON_INLINE_LIMIT, runJsonTool, type JsonToolInput, type SortMode } from "@/lib/json-tool";
import { runJsonToolInWorker } from "@/lib/json-tool-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

export default function JsonTool() {
  const [input, setInput] = useState("");
  const [indent, setIndent] = useState(2);
  const [sort, setSort] = useState<SortMode>("none");
  const [flattened, setFlattened] = useState(false);

  const request = useMemo<JsonToolInput>(() => ({ text: input, indent, sort, flattened }), [flattened, indent, input, sort]);
  const job = useAdaptive(runJsonTool, runJsonToolInWorker, request, input.length <= JSON_INLINE_LIMIT);
  const stale = job.status === "cancelled" || job.status === "error";
  const result = stale ? null : job.value;
  const pending = job.status !== "done" && !stale;
  const output = result?.state === "valid" ? result.output : "";
  const stats = result?.state === "valid" ? result.stats : null;
  const truncated = input.length > JSON_INLINE_LIMIT && output.length > JSON_DISPLAY_LIMIT;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Input"
        right={
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setInput("")}>Clear</Button>
            <Button
              size="sm"
              variant="subtle"
              onClick={() => {
                const sample = '{"team":{"name":"Samurai","members":[{"name":"Genor","role":"owner","tags":["dev","ops"]}]}}';
                setInput(sample);
              }}
            >
              Sample
            </Button>
          </div>
        }
      >
        <TextArea
          rows={18}
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste JSON here…"
        />
        <div className="mt-3">
          <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Formatting JSON" cancelLabel="Cancel formatting" onCancel={job.cancel} />
          {job.status === "cancelled" ? <Notice>Formatting cancelled. Edit the input or options to format again.</Notice> : null}
          {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
          {pending ? (
            <Notice>Checking the document…</Notice>
          ) : result?.state === "empty" ? (
            <Notice>Empty input.</Notice>
          ) : result?.state === "valid" ? (
            <Notice tone="good">Valid JSON.</Notice>
          ) : result?.state === "failed" ? (
            <Notice tone="error">{result.message}</Notice>
          ) : result?.state === "invalid" ? (
            <div className="space-y-2">
              <Notice tone="error">
                {result.issue.message} — line {result.issue.line}, column {result.issue.column}
              </Notice>
              <p className="font-mono text-[11px] text-faint">
                …{result.issue.before}
                <span className="rounded bg-danger/20 text-danger">
                  {result.issue.at}
                </span>
              </p>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Output"
        right={
          <div className="flex gap-1.5">
            <CopyButton text={output} />
            <Button
              size="sm"
              variant="subtle"
              disabled={!output}
              onClick={() => downloadText(output, "parsed.json", "application/json")}
            >
              Save .json
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Indent" className="w-28">
              <Select value={indent} onChange={(e) => setIndent(Number(e.target.value))}>
                <option value={2}>2 spaces</option>
                <option value={4}>4 spaces</option>
                <option value={1}>1 space</option>
              </Select>
            </Field>
            <Field label="Sort" className="w-36">
              <Select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
                <option value="none">Keep order</option>
                <option value="keys">Sort keys A→Z</option>
                <option value="natural">Sort keys + arrays</option>
              </Select>
            </Field>
            <Button
              size="sm"
              variant={flattened ? "primary" : "subtle"}
              className="mb-1"
              onClick={() => setFlattened((v) => !v)}
            >
              {flattened ? "Flattened" : "Flatten"}
            </Button>
            <Button
              size="sm"
              variant="subtle"
              className="mb-1"
              disabled={!output}
              onClick={() => setInput(result?.state === "valid" ? result.minified : "null")}
            >
              Minify
            </Button>
          </div>

          {stats ? (
            <StatGrid>
              <Stat label="Objects" value={stats.objects} />
              <Stat label="Arrays" value={stats.arrays} />
              <Stat label="Leaves" value={stats.leaves} />
              <Stat label="Depth" value={stats.depth} />
            </StatGrid>
          ) : null}

          <OutputBlock value={truncated ? output.slice(0, JSON_DISPLAY_LIMIT) : output} rows={18} empty="Output appears here." />
          {truncated ? (
            <p className="text-xs text-faint">Showing the first {formatInt(JSON_DISPLAY_LIMIT)} of {formatInt(output.length)} characters. Copy and Save .json use the full output.</p>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
