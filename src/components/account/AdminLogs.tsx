"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Field, Notice, Panel, SegmentedControl, Select, TextInput } from "@/components/ui";
import { cx, formatBytes, formatInt } from "@/lib/format";
import type { LogSourceView, LogTail } from "@/lib/logs/viewer";
import { call } from "./api";
import { useT } from "@/lib/i18n/react";

interface SourcesReply {
  root: string | null;
  retentionDays: number;
  sources: LogSourceView[];
}

type Level = "error" | "warn" | "info";
type LevelFilter = "all" | "warn" | "error";

const LIVE_MS = 3000;
const LINE_COUNTS = [200, 500, 2000, 5000];

/** UTC text, no locale formatting (SSR/hydration rule). */
const utc = (iso: string) => `${iso.slice(0, 19).replace("T", " ")} UTC`;

/**
 * Level of one line by its text: the app writes `<time> <out|err> <text>`; Next prints warnings on stderr too, so stderr
 * alone means "warn", words decide "error". Security events (JSON lines) are all worth a look: warn.
 */
function levelOf(line: string, source: string): Level {
  if (/\b(error|fatal|uncaught|unhandled|exception|failed|refusing|panic|crash(?:ed)?)\b|\bERR!/i.test(line)) return "error";
  if (source === "security" || /\bwarn(?:ing)?\b/i.test(line) || /^\S+ err /.test(line)) return "warn";
  return "info";
}

const LEVEL_CLASS: Record<Level, string> = { error: "text-danger", warn: "text-warn", info: "text-ink" };

/** /account/admin/logs: sources -> files -> the tail of one file, with level/text filters, live refresh and download. */
export function AdminLogs() {
  const { t } = useT();
  const [sources, setSources] = useState<SourcesReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string>("");
  const [picked, setPicked] = useState<string>("");
  const [result, setResult] = useState<{ key: string; tail: LogTail | null; error: string | null } | null>(null);
  const [lineCount, setLineCount] = useState(500);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(false);
  const pre = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  const loadSources = useCallback(() => {
    void call<SourcesReply>("GET", "/api/admin/logs").then((reply) => {
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setError(null);
      setSources(reply.body);
      setSourceId((current) => {
        if (current && reply.body.sources.some((s) => s.id === current)) return current;
        return (reply.body.sources.find((s) => s.files.length > 0) ?? reply.body.sources[0])?.id ?? "";
      });
    });
  }, []);
  useEffect(loadSources, [loadSources]);

  const source = sources?.sources.find((s) => s.id === sourceId) ?? null;
  // The picked file while the source still has it, else the source's newest one.
  const file = source?.files.some((f) => f.name === picked) ? picked : source?.files[0]?.name ?? "";
  const key = sourceId && file ? `/api/admin/logs?${new URLSearchParams({ source: sourceId, file, lines: String(lineCount) })}` : "";

  const loadTail = useCallback(() => {
    if (!key) return;
    void call<LogTail>("GET", key).then((reply) => {
      // A failed refresh keeps the lines already shown for the same file.
      setResult((prev) => (reply.ok ? { key, tail: reply.body, error: null } : { key, tail: prev?.key === key ? prev.tail : null, error: reply.message }));
    });
  }, [key]);
  useEffect(() => {
    stickToBottom.current = true;
    loadTail();
  }, [loadTail]);
  const current = result?.key === key ? result : null;
  const tail = current?.tail ?? null;
  const tailError = current?.error ?? null;
  const loading = key !== "" && !current;

  // Live refresh: only while the tab is visible; every request's body is read (call() parses it).
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadTail();
    }, LIVE_MS);
    return () => window.clearInterval(timer);
  }, [live, loadTail]);

  const shown = useMemo(() => {
    if (!tail) return [];
    const needle = query.trim().toLowerCase();
    return tail.lines
      .map((text) => ({ text, level: levelOf(text, tail.source) }))
      .filter((line) => (level === "all" || line.level === "error" || (level === "warn" && line.level === "warn")))
      .filter((line) => !needle || line.text.toLowerCase().includes(needle));
  }, [tail, level, query]);

  useEffect(() => {
    const node = pre.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [shown]);

  if (error) return <Panel title={t("Server logs")}><Notice tone="error">{error}</Notice></Panel>;
  if (!sources) return <p role="status" className="text-sm text-muted">{t("Loading log sources…")}</p>;

  const downloadHref = sourceId && file ? `/api/admin/logs?${new URLSearchParams({ source: sourceId, file, download: "1" })}` : null;

  return (
    <section aria-label={t("Server logs")} className="space-y-4">
      <Panel
        title={t("Sources")}
        right={<Button size="sm" onClick={loadSources}>{t("Refresh list")}</Button>}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {sources.root ? <>{t("Files under")}{" "} <code className="font-mono text-xs">{sources.root}</code>{t(", kept {retentionDays} days (", { retentionDays: formatInt(sources.retentionDays) })}<code>logRetentionDays</code>).</> : <>{t("File logging is off on this server (")}<code>KNIFE_LOG_DIR=off</code>{t("); only security events are listed.")}</>}
          </p>
          <Field label={t("Source")}>
            <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {sources.sources.map((s) => (
                <option key={s.id} value={s.id}>{`${s.label} (${s.files.length})`}</option>
              ))}
            </Select>
          </Field>
          {source ? <p className="text-xs text-faint">{t(source.description)}</p> : null}
        </div>
      </Panel>

      <Panel title={source ? `${source.label}: files (${source.files.length})` : t("Files")} bodyClassName="p-0 sm:p-0">
        {!source || source.files.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">{t("No files yet.")}</p>
        ) : (
          <div className="max-h-[18rem] overflow-auto">
            <table className="w-full min-w-[36rem] text-left text-sm" aria-label={t("Log files")}>
              <thead className="sticky top-0 border-b border-line bg-surface text-xs text-faint">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{t("File")}</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">{t("Size")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("Modified")}</th>
                  <th scope="col" className="px-4 py-2 font-medium">{t("Action")}</th>
                </tr>
              </thead>
              <tbody>
                {source.files.map((f) => (
                  <tr key={f.name} data-log-file={f.name} className={cx("border-b border-line last:border-0", f.name === file && "bg-raised/60")}>
                    <td className="px-4 py-2 font-mono text-xs text-ink wrap-anywhere">{f.name}{f.name === file ? <Badge className="ml-2" tone="good">{t("shown")}</Badge> : null}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-muted">{formatBytes(f.size)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-muted">{utc(f.mtime)}</td>
                    <td className="px-4 py-2"><Button size="sm" variant="ghost" onClick={() => setPicked(f.name)} aria-label={t("Show {name}", { name: f.name })}>{t("Show")}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {file ? (
        <Panel
          title={<span className="font-mono">{file}</span>}
          right={
            <span className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-muted">
                <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
                {t("Live refresh")}
              </label>
              <Button size="sm" onClick={loadTail}>{t("Refresh")}</Button>
              {downloadHref ? <a className="text-sm text-accent-soft underline underline-offset-2" href={downloadHref} download={file}>{t("Download")}</a> : null}
            </span>
          }
        >
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[auto_1fr_auto] sm:items-end">
              <SegmentedControl<LevelFilter>
                label={t("Level")}
                value={level}
                onChange={setLevel}
                options={[{ value: "all", label: "All" }, { value: "warn", label: "Warnings + errors" }, { value: "error", label: "Errors" }]}
              />
              <Field label={t("Filter")}>
                <TextInput type="search" value={query} placeholder={t("text in the line")} onChange={(e) => setQuery(e.target.value)} />
              </Field>
              <Field label={t("Lines")}>
                <Select value={String(lineCount)} onChange={(e) => setLineCount(Number(e.target.value))}>
                  {LINE_COUNTS.map((n) => <option key={n} value={n}>{formatInt(n)}</option>)}
                </Select>
              </Field>
            </div>
            <p role="status" className="text-xs text-faint">
              {loading
                ? t("Loading…")
                : tail
                  ? `${formatInt(shown.length)} of ${formatInt(tail.lines.length)} lines shown${tail.truncated ? " (the end of a longer file)" : ""}, ${formatBytes(tail.size)}, modified ${utc(tail.mtime)}${live ? ", refreshing every 3 s" : ""}.`
                  : ""}
            </p>
            {tailError ? <Notice tone="error">{tailError}</Notice> : null}
            <pre
              ref={pre}
              aria-label={t("Log lines")}
              onScroll={(e) => {
                const node = e.currentTarget;
                stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
              }}
              className="sk-input max-h-[60vh] min-h-[12rem] overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words"
            >
              {shown.length === 0 ? (
                <span className="text-faint">{tail && tail.lines.length ? t("No line matches the filter.") : t("The file is empty.")}</span>
              ) : (
                shown.map((line, index) => (
                  <span key={index} data-level={line.level} className={LEVEL_CLASS[line.level]}>{`${line.text}\n`}</span>
                ))
              )}
            </pre>
          </div>
        </Panel>
      ) : null}
    </section>
  );
}
