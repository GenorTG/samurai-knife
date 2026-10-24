"use client";

/**
 * The node panel (n8n's "NDV"): input data on the left, parameters / credentials / settings in the middle, output data
 * on the right, all from the latest run shown on the canvas. Clicking an input column inserts it as an expression into
 * the parameter edited last.
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Button, CopyButton, Drawer, Field, Notice, SegmentedControl, Select, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import type { PublicCredential, RunRecord, HookUrls } from "@/lib/workflows/client";
import { paramVisible } from "@/lib/workflows/editor-model";
import { normalizeHookPath } from "@/lib/workflows/validate";
import { outputLabels, type Connection, type NodeMeta, type NodeParam, type NodeRun, type WorkflowNode } from "@/lib/workflows/types";
import { CredentialForm } from "./CredentialsTab";
import { DataView } from "./DataView";
import { ParamFields } from "./ParamForm";

function lastRun(record: RunRecord | null, name: string): NodeRun | undefined {
  const runs = record?.runData[name];
  return runs?.[runs.length - 1];
}

function insertPath(value: unknown, path: string): string {
  const token = `{{ ${path} }}`;
  if (typeof value === "string" && value.startsWith("=")) return `${value}${value.length > 1 ? " " : ""}${token}`;
  if (typeof value === "string" && value) return `=${value}${token}`;
  return `=${token}`;
}

export function NodePanel({
  node,
  meta,
  connections,
  record,
  credentials,
  hooks,
  running,
  listening,
  onChange,
  onRename,
  onClose,
  onRunNode,
  onListen,
  onCredentialCreated,
}: {
  node: WorkflowNode;
  meta: NodeMeta;
  connections: Connection[];
  record: RunRecord | null;
  credentials: PublicCredential[];
  hooks: HookUrls | null;
  running: boolean;
  listening: boolean;
  onChange: (node: WorkflowNode) => void;
  onRename: (from: string, to: string) => string | null;
  onClose: () => void;
  onRunNode: (name: string) => void;
  onListen: () => void;
  onCredentialCreated: () => void;
}) {
  const [tab, setTab] = useState<"parameters" | "settings">("parameters");
  const [lastField, setLastField] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(node.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [inputPick, setInputPick] = useState(0);
  const [outputPick, setOutputPick] = useState(0);
  const [creating, setCreating] = useState<{ slot: string; types: string[] } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // Opened from the node list or the canvas: take focus so Escape closes it and Tab stays inside.
  useEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus({ preventScroll: true });
  }, []);
  const incoming = connections.filter((c) => c.to.node === node.name);
  const sources = incoming.map((c) => ({ label: incoming.length > 1 ? `${c.from.node}${c.to.input ? ` → input ${c.to.input + 1}` : ""}` : c.from.node, run: lastRun(record, c.from.node), output: c.from.output }));
  const source = sources[Math.min(inputPick, Math.max(0, sources.length - 1))];
  const own = lastRun(record, node.name);
  const outputs = [...outputLabels(meta, node.parameters), ...(node.onError === "errorOutput" ? ["error"] : [])];
  const set = (patch: Partial<WorkflowNode>) => onChange({ ...node, ...patch });
  const setParam = (name: string, value: unknown) => set({ parameters: { ...node.parameters, [name]: value } });
  const pick = (path: string) => {
    const target = lastField && meta.params.some((p) => p.name === lastField && (p.type === "string" || p.type === "number" || p.type === "json")) ? lastField : null;
    if (!target) return;
    setParam(target, insertPath(node.parameters[target] ?? meta.params.find((p) => p.name === target)?.default, path));
  };
  const commitName = () => {
    const clean = nameDraft.trim();
    if (!clean || clean === node.name) {
      setNameDraft(node.name);
      setNameError(null);
      return;
    }
    const problem = onRename(node.name, clean);
    setNameError(problem);
    if (problem) setNameDraft(node.name);
  };
  const slots = (meta.credentials ?? []).filter((slot) => !slot.showIf || paramVisible({ name: slot.name, label: slot.label, type: "string", showIf: slot.showIf } as NodeParam, node.parameters, meta.params));
  const hookPath = normalizeHookPath(node.parameters.path);

  return (
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Node ${node.name}`} className="fixed inset-0 z-40 flex bg-black/45 p-2 outline-none sm:p-4" onKeyDown={(event) => event.key === "Escape" && !creating && onClose()}>
      <div className="sk-pop flex min-h-0 w-full flex-col overflow-hidden rounded-tool border border-line-strong bg-bg shadow-pop">
        <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <input
            aria-label="Node name"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            }}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold text-ink hover:border-line focus:border-line-strong focus:outline-none"
          />
          <Badge>{meta.label}</Badge>
          {nameError ? <span className="text-xs text-danger">{nameError}</span> : null}
          <Button size="sm" variant="primary" disabled={running} onClick={() => onRunNode(node.name)} title="Run the workflow up to this node">
            {running ? "Running…" : meta.inputs === 0 ? "Run from here" : "Run up to here"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close node panel">
            Close
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(22rem,1.15fr)_minmax(0,1fr)] lg:overflow-hidden">
          {meta.inputs > 0 ? (
            <section aria-label="Input" className="min-h-0 space-y-2 overflow-y-auto border-b border-line p-3 lg:border-r lg:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">Input</h3>
                {sources.length > 1 ? (
                  <Select aria-label="Input source" value={String(inputPick)} onChange={(event) => setInputPick(Number(event.target.value))} className="h-7 w-auto text-xs">
                    {sources.map((entry, index) => (
                      <option key={index} value={index}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </div>
              {source ? (
                <DataView
                  label="Input data"
                  items={source.run?.outputs[source.output] ?? []}
                  total={source.run?.outputCounts?.[source.output] ?? source.run?.outputs[source.output]?.length}
                  empty={source.run ? "The previous node sent no items here." : "Run the workflow to see the data that arrives here."}
                  onPick={lastField ? pick : undefined}
                />
              ) : (
                <p className="py-6 text-center text-[13px] text-faint">Connect a node to this one&apos;s input.</p>
              )}
              {source && !lastField ? <p className="text-[11px] text-faint">Tip: click into a parameter, then click a column to use it.</p> : null}
            </section>
          ) : null}
          <section aria-label="Parameters" className={cx("min-h-0 space-y-4 overflow-y-auto border-b border-line bg-surface p-4 lg:border-b-0", meta.inputs === 0 && "lg:col-span-2")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl label="Node panel section" value={tab} onChange={setTab} options={[{ value: "parameters", label: "Parameters" }, { value: "settings", label: "Settings" }]} />
              <span className="text-xs text-faint">{meta.description}</span>
            </div>
            {tab === "parameters" ? (
              <>
                {node.type === "core.webhook" && hooks ? (
                  <div className="space-y-2 rounded-lg border border-line bg-raised/40 p-3">
                    {[
                      ["Test URL", `${hooks.test}${hookPath ? `/${hookPath}` : ""}`],
                      ["Production URL", `${hooks.production}${hookPath ? `/${hookPath}` : ""}`],
                    ].map(([label, url]) => (
                      <div key={label} className="space-y-1">
                        <span className="sk-label block">{label}</span>
                        <div className="flex items-center gap-1.5">
                          <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-field px-2 py-1 font-mono text-[12px]" title={url}>
                            {String(node.parameters.httpMethod ?? "POST")} {url}
                          </code>
                          <CopyButton text={url} label={`Copy ${label}`} />
                        </div>
                      </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant={listening ? "danger" : "primary"} onClick={onListen}>
                        {listening ? "Stop listening" : "Listen for a test call"}
                      </Button>
                      <span className="text-[11px] text-faint">The test URL runs your unsaved version once; the production URL works while the workflow is active.</span>
                    </div>
                  </div>
                ) : null}
                {slots.map((slot) => {
                  const options = credentials.filter((credential) => slot.types.includes(credential.type));
                  const value = node.credentials?.[slot.name] ?? "";
                  return (
                    <Field key={slot.name} label={`${slot.label}${slot.required ? " *" : ""}`}>
                      <div className="flex gap-1.5">
                        <Select
                          value={value}
                          onChange={(event) => {
                            if (event.target.value === "__new") return setCreating({ slot: slot.name, types: slot.types });
                            const next = { ...(node.credentials ?? {}) };
                            if (event.target.value) next[slot.name] = event.target.value;
                            else delete next[slot.name];
                            set({ credentials: next });
                          }}
                        >
                          <option value="">Choose a credential…</option>
                          {options.map((credential) => (
                            <option key={credential.id} value={credential.id}>
                              {credential.name}
                              {credential.connected === false ? " (not connected)" : ""}
                            </option>
                          ))}
                          <option value="__new">+ New credential…</option>
                        </Select>
                      </div>
                    </Field>
                  );
                })}
                {meta.params.length ? (
                  <ParamFields params={meta.params} values={node.parameters} onChange={setParam} onFocusField={setLastField} />
                ) : (
                  <p className="text-[13px] text-muted">This node has no parameters.</p>
                )}
              </>
            ) : (
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={Boolean(node.disabled)} onChange={(event) => set({ disabled: event.target.checked || undefined })} />
                  Disabled (passes its input through unchanged)
                </label>
                {meta.inputs > 0 ? (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(node.alwaysOutputData)} onChange={(event) => set({ alwaysOutputData: event.target.checked || undefined })} />
                      Run the next nodes even when this one outputs no items
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={Boolean(node.executeOnce)} onChange={(event) => set({ executeOnce: event.target.checked || undefined })} />
                      Execute once (with the first item only)
                    </label>
                  </>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={Boolean(node.retryOnFail)} onChange={(event) => set({ retryOnFail: event.target.checked || undefined })} />
                  Retry when it fails
                </label>
                {node.retryOnFail ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Tries">
                      <TextInput type="number" min={1} max={10} value={String(node.maxTries ?? 3)} onChange={(event) => set({ maxTries: Math.max(1, Math.min(10, Number(event.target.value) || 3)) })} />
                    </Field>
                    <Field label="Wait between tries (ms)">
                      <TextInput type="number" min={0} max={60000} value={String(node.waitBetweenTries ?? 1000)} onChange={(event) => set({ waitBetweenTries: Math.max(0, Math.min(60000, Number(event.target.value) || 0)) })} />
                    </Field>
                  </div>
                ) : null}
                <Field label="When it fails">
                  <Select value={node.onError ?? "stop"} onChange={(event) => set({ onError: event.target.value === "stop" ? undefined : (event.target.value as WorkflowNode["onError"]) })}>
                    <option value="stop">Stop the workflow</option>
                    <option value="continue">Continue (the error goes into the items)</option>
                    <option value="errorOutput">Continue on an extra error output</option>
                  </Select>
                </Field>
                <Field label="Notes">
                  <TextArea rows={4} value={node.notes ?? ""} onChange={(event) => set({ notes: event.target.value || undefined })} className="font-sans text-sm" />
                </Field>
              </div>
            )}
          </section>
          <section aria-label="Output" className="min-h-0 space-y-2 overflow-y-auto p-3 lg:border-l lg:border-line">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">Output</h3>
              {outputs.length > 1 ? (
                <Select aria-label="Output branch" value={String(outputPick)} onChange={(event) => setOutputPick(Number(event.target.value))} className="h-7 w-auto text-xs">
                  {outputs.map((label, index) => (
                    <option key={index} value={index}>
                      {label} ({own?.outputCounts?.[index] ?? own?.outputs[index]?.length ?? 0})
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
            {own?.error ? (
              <Notice tone="error">
                {own.error.message}
                {own.error.description ? <span className="mt-1 block text-[12px] opacity-90">{own.error.description}</span> : null}
              </Notice>
            ) : null}
            <DataView label="Output data" items={own?.outputs[outputPick] ?? []} total={own?.outputCounts?.[outputPick]} empty={own ? "No items on this output." : "Run the workflow (or this node) to see its output."} />
            {own ? <p className="text-[11px] text-faint">Ran in {own.ms} ms{own.trimmed ? " · stored run keeps the first items only" : ""}.</p> : null}
            {own?.logs?.length ? (
              <div className="space-y-1">
                <h4 className="font-mono text-[10px] font-semibold tracking-[0.14em] text-faint uppercase">Console</h4>
                <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-field p-2 font-mono text-[12px] text-muted">{own.logs.join("\n")}</pre>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <Drawer open={Boolean(creating)} title="New credential" onClose={() => setCreating(null)}>
        {creating ? (
          <CredentialForm
            allowedTypes={creating.types}
            onCancel={() => setCreating(null)}
            onSaved={(credential) => {
              set({ credentials: { ...(node.credentials ?? {}), [creating.slot]: credential.id } });
              setCreating(null);
              onCredentialCreated();
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
