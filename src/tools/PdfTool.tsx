"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, CopyButton, Dropzone, Field, Notice, NumberField, OutputBlock, Panel, Select, Stat, StatGrid, TextInput } from "@/components/ui";
import { cx, downloadBlob, formatBytes, parseRanges, plural } from "@/lib/format";
import { startPdfJob, type PdfJob, type PdfJobPhase } from "@/lib/pdf-client";

type Action = "info" | "text" | "extract" | "merge" | "rotate" | "split" | "reorder" | "compress" | "number" | "watermark" | "protect" | "unlock";

const ACTIONS: { value: Action; label: string; hint: string; needsPages: boolean }[] = [
  { value: "info", label: "Inspect", hint: "Page count, sizes, metadata, encryption — nothing is modified.", needsPages: false },
  { value: "text", label: "Extract text", hint: "Text layer only. Scanned PDFs need OCR, which this does not do.", needsPages: true },
  { value: "extract", label: "Cut pages", hint: "Keep only the listed pages as a new PDF.", needsPages: true },
  { value: "rotate", label: "Rotate", hint: "Rotate selected pages by 90/180/270°.", needsPages: true },
  { value: "split", label: "Split", hint: "Break into N-page files, delivered as one zip.", needsPages: false },
  { value: "merge", label: "Merge", hint: "Append every attached PDF in order. Needs 2+ files.", needsPages: false },
  { value: "reorder", label: "Reorder pages", hint: "List every page exactly once in the new order, e.g. 3,1,2.", needsPages: true },
  { value: "compress", label: "Compress", hint: "Lossless stream compression and duplicate-object removal; embedded images are not downsampled.", needsPages: false },
  { value: "number", label: "Page numbers", hint: "Stamp sequential numbers at the bottom of every page.", needsPages: false },
  { value: "watermark", label: "Watermark", hint: "Add a translucent diagonal text watermark to every page.", needsPages: false },
  { value: "protect", label: "Protect", hint: "Encrypt the PDF with AES-256. Use at least 8 characters.", needsPages: false },
  { value: "unlock", label: "Unlock", hint: "Remove a PDF password you know, then download an unprotected copy.", needsPages: false },
];

const SINGLE_FILE_ACTIONS = new Set<Action>([
  "extract", "rotate", "reorder", "compress", "number", "watermark", "protect", "unlock",
]);

interface DocInfo {
  name: string;
  pages: number;
  bytes: number;
  encrypted: boolean;
  title?: string | null;
  author?: string | null;
  producer?: string | null;
  creator?: string | null;
  page_sizes: { page: number; w: number; h: number }[];
}

function phaseText(phase: PdfJobPhase | null): string | null {
  if (!phase) return null;
  if (phase.kind === "uploading") return "Uploading…";
  if (phase.kind === "running") return "Processing…";
  return phase.ahead > 0 ? `Queued (${phase.ahead} ahead)…` : "Queued (next up)…";
}

export default function PdfTool() {
  const [files, setFiles] = useState<File[]>([]);
  const [action, setAction] = useState<Action>("info");
  const [pages, setPages] = useState("");
  const [angle, setAngle] = useState(90);
  const [perFile, setPerFile] = useState(1);
  const [startNumber, setStartNumber] = useState("1");
  const [stampText, setStampText] = useState("CONFIDENTIAL");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [docs, setDocs] = useState<DocInfo[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<string | null>(null);
  const [phase, setPhase] = useState<PdfJobPhase | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const jobRef = useRef<PdfJob | null>(null);

  // Leaving the tool must not leave a job holding the server's single heavy slot.
  useEffect(() => () => void jobRef.current?.cancel(), []);

  const cancelRun = useCallback(() => {
    void jobRef.current?.cancel();
  }, []);

  const active = ACTIONS.find((a) => a.value === action)!;

  const addFiles = useCallback((incoming: File[]) => {
    const pdfs = incoming.filter((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    if (pdfs.length === 0) {
      setError("Those are not PDF files.");
      return;
    }
    setError(null);
    setDownloaded(null);
    setText("");
    setDocs(null);
    setNote(null);
    setFiles((current) => [...current, ...pdfs].slice(0, 40));
  }, []);

  const totalBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const canRun = useMemo(() => {
    if (busy || files.length === 0) return false;
    if (action === "merge" && files.length < 2) return false;
    if (SINGLE_FILE_ACTIONS.has(action) && files.length !== 1) return false;
    if (action === "reorder" && !pages.trim()) return false;
    if (action === "watermark" && !stampText.trim()) return false;
    if (action === "protect" && password.length < 8) return false;
    if (action === "unlock" && !password) return false;
    if (active.needsPages && pages.trim()) {
      // Syntax check only; the real page bounds are validated server-side.
      return parseRanges(pages, Number.MAX_SAFE_INTEGER) !== null;
    }
    return true;
  }, [action, active.needsPages, busy, files, pages, password, stampText]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setText("");
    setDocs(null);
    setNote(null);
    setDownloaded(null);
    setCancelled(false);
    setPhase({ kind: "uploading" });

    try {
      const form = new FormData();
      form.set("action", action);
      const params: Record<string, unknown> = {
        pages,
        angle,
        per_file: perFile,
        pages_break: true,
        start_number: Math.min(1_000_000, Math.max(1, Number(startNumber) || 1)),
        stamp_text: stampText,
      };
      if (action === "protect" || action === "unlock") params.password = password;
      form.set("params", JSON.stringify(params));
      for (const file of files) form.append("file", file, file.name);

      const job = startPdfJob(form, setPhase);
      jobRef.current = job;
      const outcome = await job.result;

      if (outcome.kind === "cancelled") {
        setCancelled(true);
        return;
      }
      if (outcome.kind === "json") {
        const data = outcome.data;
        if (data?.documents) setDocs(data.documents as DocInfo[]);
        if (typeof data?.text === "string") {
          setText(data.text);
          setNote(`${plural(data.chars ?? 0, "character")} · ${outcome.ms ?? 0} ms`);
        }
        if (data?.parts) setNote(`${plural(data.parts, "file")} produced`);
        return;
      }

      const { blob, filename } = outcome;
      downloadBlob(blob, filename);
      const compression = action === "compress" && files[0]?.size
        ? ` · ${((1 - blob.size / files[0].size) * 100).toFixed(1)}% ${blob.size <= files[0].size ? "smaller" : "larger"}`
        : "";
      setDownloaded(`${filename} · ${formatBytes(blob.size)}${compression}`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Request failed — is the dev server running?");
    } finally {
      jobRef.current = null;
      setPhase(null);
      setBusy(false);
    }
  }, [action, angle, files, pages, password, perFile, stampText, startNumber]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel
          title="Files"
          right={
            files.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setFiles([])}>Clear</Button>
            ) : null
          }
        >
          <div className="space-y-3">
            <Dropzone
              accept="application/pdf,.pdf"
              multiple
              hint="PDFs only · up to 40 files · 200 MB each"
              onFiles={addFiles}
            />
            {files.length > 0 ? (
              <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center gap-2 bg-surface px-3 py-2 text-sm">
                    <span className="w-5 shrink-0 font-mono text-[11px] text-faint tabular-nums">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{formatBytes(file.size)}</span>
                    <button
                      autoComplete="off"
                      type="button"
                      title="Remove"
                      onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                      className="shrink-0 text-faint hover:text-danger"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {files.length > 0 ? (
              <p className="font-mono text-[11px] text-faint">
                {plural(files.length, "file")} · {formatBytes(totalBytes)}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title="Operation">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {ACTIONS.map((item) => (
                <button
                  autoComplete="off"
                  key={item.value}
                  type="button"
                  onClick={() => setAction(item.value)}
                  className={cx(
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    action === item.value
                      ? "border-accent/45 bg-accent/10 text-accent-soft"
                      : "border-line bg-raised/50 text-muted hover:border-line-strong hover:text-ink",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <p className="text-xs leading-relaxed text-faint">{active.hint}</p>

            {active.needsPages ? (
              <Field label={action === "reorder" ? "New page order" : "Pages"} hint={action === "reorder" ? "List each page once; ranges work too. Example: 3,1-2" : "Blank = all pages. Syntax: 1-3,7,9-11"}>
                <TextInput
                  value={pages}
                  spellCheck={false}
                  onChange={(e) => setPages(e.target.value)}
                  placeholder="1-3,7"
                  className="font-mono"
                />
              </Field>
            ) : null}

            {action === "rotate" ? (
              <Field label="Angle">
                <Select value={angle} onChange={(e) => setAngle(Number(e.target.value))}>
                  <option value={90}>90° clockwise</option>
                  <option value={180}>180°</option>
                  <option value={270}>270° (counter-clockwise)</option>
                </Select>
              </Field>
            ) : null}

            {action === "split" ? (
              <Field label="Pages per file">
                <NumberField type="text" min={1} max={Infinity} integer value={perFile} onValueChange={setPerFile} />
              </Field>
            ) : null}

            {action === "number" ? (
              <Field label="First page number">
                <TextInput type="number" min={1} max={1_000_000} inputMode="numeric" value={startNumber} onChange={(e) => setStartNumber(e.target.value)} />
              </Field>
            ) : null}

            {action === "watermark" ? (
              <Field label="Watermark text" hint="Basic Latin characters; placed diagonally at low opacity.">
                <TextInput maxLength={100} value={stampText} onChange={(e) => setStampText(e.target.value)} />
              </Field>
            ) : null}

            {action === "protect" || action === "unlock" ? (
              <Field label="PDF password" hint={action === "protect" ? "At least 8 characters; the password is used only for this local request." : "Enter the password already on the PDF."}>
                <TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            ) : null}

            <Button variant="primary" disabled={!canRun} onClick={() => void run()} className="w-full">
              {busy ? "Working…" : action === "merge" ? "Merge & download" : active.label}
            </Button>

            <div className="flex min-h-7 items-center justify-between gap-2">
              <p role="status" aria-live="polite" className="min-w-0 text-xs text-faint">
                {phaseText(phase) ?? (cancelled ? "Cancelled." : "")}
              </p>
              {busy ? (
                <Button size="sm" variant="ghost" onClick={cancelRun} disabled={phase === null}>Cancel</Button>
              ) : null}
            </div>

            {action === "merge" && files.length < 2 ? (
              <Notice>Add at least two PDFs to merge — order follows the list above.</Notice>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}

        {docs ? (
          <Panel title="Inspect" bodyClassName="space-y-3">
            {docs.map((doc) => (
              <div key={doc.name} className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-sm text-ink">{doc.name}</h3>
                  <span className="font-mono text-[11px] text-faint">
                    {plural(doc.pages, "page")} · {formatBytes(doc.bytes)}
                    {doc.encrypted ? " · encrypted" : ""}
                  </span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                  {doc.title ? (
                    <>
                      <dt className="text-faint">Title</dt>
                      <dd className="font-mono text-ink">{doc.title}</dd>
                    </>
                  ) : null}
                  {doc.author ? (
                    <>
                      <dt className="text-faint">Author</dt>
                      <dd className="font-mono text-ink">{doc.author}</dd>
                    </>
                  ) : null}
                  {doc.producer ? (
                    <>
                      <dt className="text-faint">Producer</dt>
                      <dd className="font-mono text-ink">{doc.producer}</dd>
                    </>
                  ) : null}
                  {doc.page_sizes[0] ? (
                    <>
                      <dt className="text-faint">Page size</dt>
                      <dd className="font-mono text-ink">
                        {doc.page_sizes[0].w} × {doc.page_sizes[0].h} pt
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ))}
          </Panel>
        ) : null}

        {downloaded ? (
          <Panel title="Delivered">
            <div className="space-y-2">
              <Notice tone="good">Saved: <span className="font-mono">{downloaded}</span></Notice>
              {note ? <p className="text-xs text-faint">{note}</p> : null}
            </div>
          </Panel>
        ) : null}

        <Panel
          title="Extracted text"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={text} />
              <Button
                size="sm"
                variant="subtle"
                disabled={!text}
                onClick={() => {
                  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "extracted.txt";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Save .txt
              </Button>
            </div>
          }
        >
          <div className="space-y-2">
            {note && !downloaded ? <p className="text-xs text-faint">{note}</p> : null}
            <OutputBlock value={text} rows={20} empty="Run “Extract text” to see the text layer here." />
          </div>
        </Panel>

        <Panel title="Where this runs">
          <StatGrid>
            <Stat label="Runtime" value="Python 3.12" />
            <Stat label="Library" value="pypdf" />
            <Stat label="Isolation" value="venv" />
            <Stat label="Uploads" value="localhost" />
          </StatGrid>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Files are written to a temp dir, processed by{" "}
            <span className="font-mono">server/py/scripts/pdf_tool.py</span>, and deleted in the
            same request. Nothing is stored, and nothing leaves the machine.
          </p>
        </Panel>
      </div>
    </div>
  );
}
