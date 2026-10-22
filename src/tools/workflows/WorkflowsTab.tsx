"use client";

/** Workflows tab: the account's workflows (create, import, open, delete) and the editor (`?workflow=<id>`). */
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, EmptyState, Notice, Panel } from "@/components/ui";
import { workflowsApi, type WorkflowSummary } from "@/lib/workflows/client";
import { TEMPLATES } from "@/lib/workflows/editor-model";
import { fromN8n } from "@/lib/workflows/import";
import { Editor } from "./Editor";

const TRIGGER_LABELS: Record<string, string> = { manual: "Manual", schedule: "Schedule", webhook: "Webhook", subworkflow: "Sub-workflow", error: "Error", chat: "Chat" };

export default function WorkflowsTab() {
  const params = useSearchParams();
  const router = useRouter();
  const current = params.get("workflow");
  const open = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("workflow", id);
    else next.delete("workflow");
    router.push(`?${next.toString()}`, { scroll: false });
  };
  if (current && /^[a-z0-9]{8,24}$/.test(current)) return <Editor key={current} id={current} onBack={() => open(null)} />;
  return <WorkflowList onOpen={open} />;
}

function WorkflowList({ onOpen }: { onOpen: (id: string) => void }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "good" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    workflowsApi.list().then(
      (result) => setWorkflows(result.workflows),
      (error: unknown) => {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
        setWorkflows([]);
      },
    );
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);

  const create = async (build: () => Parameters<typeof workflowsApi.create>[0]) => {
    setBusy(true);
    try {
      const { workflow } = await workflowsApi.create(build());
      onOpen(workflow.id);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      if (parsed.format === "smart-knife-workflow/1") {
        await create(() => ({ name: String(parsed.name ?? file.name.replace(/\.json$/i, "")), nodes: parsed.nodes as never, connections: parsed.connections as never, settings: parsed.settings as never }));
        return;
      }
      const converted = fromN8n(parsed);
      if (!converted) throw new Error("Not a Smart Knife or n8n workflow file.");
      await create(() => ({ name: converted.name, nodes: converted.nodes, connections: converted.connections }));
      if (converted.skipped.length) setNotice({ tone: "info", text: `Imported. Not available yet, replaced by No Operation nodes: ${converted.skipped.join(", ")}.` });
    } catch (error) {
      setNotice({ tone: "error", text: `Import failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  return (
    <div className="space-y-4">
      <Panel
        title="Workflows"
        right={
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => fileInput.current?.click()}>
              Import JSON
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void create(() => ({ name: "My workflow", ...TEMPLATES[0].build() }))}>
              New workflow
            </Button>
          </div>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Workflow file to import"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
        <p className="mb-4 text-[13px] text-muted">
          Connect nodes on a canvas: triggers (manual, schedule, webhook), HTTP requests, code, conditions, merges, loops, files. Runs happen in an isolated worker that only has workflow nodes; your code runs sandboxed. n8n exports can be imported (supported nodes).
        </p>
        {notice ? (
          <div className="mb-3">
            <Notice tone={notice.tone}>{notice.text}</Notice>
          </div>
        ) : null}
        {workflows === null ? (
          <p role="status" className="text-sm text-muted">Loading workflows…</p>
        ) : workflows.length === 0 ? (
          <EmptyState title="No workflows yet">Start from a template below, or import a JSON file.</EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Your workflows">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => onOpen(workflow.id)}>
                  <span className="block truncate text-sm font-semibold text-ink">{workflow.name}</span>
                  <span className="block text-xs text-muted">
                    {workflow.nodeCount} node{workflow.nodeCount === 1 ? "" : "s"} · {workflow.triggers.map((t) => TRIGGER_LABELS[t] ?? t).join(", ") || "no trigger"} · updated {new Date(workflow.updatedAt).toLocaleString("en-GB")}
                  </span>
                </button>
                {workflow.active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>}
                <Button size="sm" onClick={() => onOpen(workflow.id)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${workflow.name}" with its run history?`)) return;
                    try {
                      await workflowsApi.remove(workflow.id);
                      reload();
                    } catch (error) {
                      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
                    }
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Start from a template">
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Templates">
          {TEMPLATES.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void create(() => ({ name: template.name, ...template.build() }))}
                className="h-full w-full cursor-pointer rounded-lg border border-line bg-raised/40 px-3 py-2.5 text-left hover:border-accent/60 hover:bg-accent/5 disabled:opacity-50"
              >
                <span className="block text-sm font-semibold text-ink">{template.name}</span>
                <span className="block text-[13px] text-muted">{template.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
