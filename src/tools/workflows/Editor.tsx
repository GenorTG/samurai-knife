"use client";

/**
 * The workflow editor (docs/WORKFLOWS.md): React Flow canvas over the workflow model (the model is the source of truth;
 * the canvas is derived from it), node panel, node picker, run with live per-node status, test webhooks, run history,
 * settings, export. Unsaved changes run as they are (the run posts the draft).
 */
import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Badge, Button, Drawer, Field, FullscreenButton, Notice, Select, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { nodeMeta } from "@/lib/workflows/catalog/index";
import { workflowsApi, WorkflowApiError, type Draft, type HookUrls, type PublicCredential, type RunRecord, type RunSummary, type WorkflowSummary } from "@/lib/workflows/client";
import { addConnection, createNode, removeNodes, renameNode } from "@/lib/workflows/editor-model";
import type { Connection, NodeMeta, Workflow, WorkflowNode, WorkflowSettings } from "@/lib/workflows/types";
import { activationProblems, structuralProblems } from "@/lib/workflows/validate";
import { NodeCard, type CardNode, type NodeStatus } from "./NodeCard";
import { NodePanel } from "./NodePanel";
import { NodePicker } from "./NodePicker";

const NODE_TYPES = { wf: NodeCard };

interface RunView {
  runId?: string;
  status: "running" | "success" | "error" | "waiting" | "canceled";
  nodes: Record<string, NodeStatus>;
  record: RunRecord | null;
  error?: string;
}

function statusesFromRecord(record: RunRecord): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  for (const [name, runs] of Object.entries(record.runData)) {
    const last = runs[runs.length - 1];
    if (!last) continue;
    if (last.error) out[name] = { state: "error", error: last.error.message };
    else out[name] = { state: record.status === "waiting" && record.lastNode === name ? "waiting" : "success", counts: last.outputCounts ?? last.outputs.map((o) => o.length) };
  }
  return out;
}

const FLOW_STYLE = {
  "--xy-background-color": "var(--c-bg)",
  "--xy-background-pattern-color": "color-mix(in oklab, var(--c-faint) 45%, transparent)",
  "--xy-edge-stroke": "var(--c-faint)",
  "--xy-edge-stroke-selected": "var(--c-accent)",
  "--xy-edge-stroke-width": "2",
  "--xy-connectionline-stroke": "var(--c-accent)",
  "--xy-minimap-background-color": "var(--c-surface)",
  "--xy-minimap-mask-background-color": "color-mix(in oklab, var(--c-bg) 70%, transparent)",
  "--xy-minimap-node-background-color": "var(--c-raised)",
  "--xy-controls-button-background-color": "var(--c-surface)",
  "--xy-controls-button-background-color-hover": "var(--c-raised)",
  "--xy-controls-button-color": "var(--c-ink)",
  "--xy-controls-button-border-color": "var(--c-line)",
  "--xy-node-boxshadow-selected": "none",
  "--xy-attribution-background-color": "transparent",
} as CSSProperties;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EditorInner({ id, onBack }: { id: string; onBack: () => void }) {
  const flow = useReactFlow();
  const shell = useRef<HTMLDivElement>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [hooks, setHooks] = useState<HookUrls | null>(null);
  const [name, setName] = useState("");
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "good" | "error" | "info" | "warn"; text: string; reload?: boolean } | null>(null);
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | { position: [number, number]; from?: { node: string; output: number } }>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [credentials, setCredentials] = useState<PublicCredential[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [listening, setListening] = useState(false);
  const [panel, setPanel] = useState<"runs" | "settings" | null>(null);
  const [startTrigger, setStartTrigger] = useState<string>("");
  const runAbort = useRef<AbortController | null>(null);
  const listenAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const [{ workflow: loaded, hooks: urls, runs: history }, list] = await Promise.all([workflowsApi.get(id), workflowsApi.list()]);
    setWorkflow(loaded);
    setHooks(urls);
    setName(loaded.name);
    setNodes(loaded.nodes);
    setConnections(loaded.connections);
    setSettings(loaded.settings);
    setRuns(history);
    setCredentials(list.credentials);
    setWorkflows(list.workflows);
    setDirty(false);
    setNotice(null);
    return loaded;
  }, [id]);

  useEffect(() => {
    let alive = true;
    load().then(
      (loaded) => {
        if (!alive) return;
        if (loaded.nodes.length) requestAnimationFrame(() => flow.fitView({ padding: 0.25, maxZoom: 1.1 }));
      },
      (error: unknown) => alive && setNotice({ tone: "error", text: message(error) }),
    );
    return () => {
      alive = false;
      runAbort.current?.abort();
      listenAbort.current?.abort();
    };
  }, [load, flow]);

  const byName = useMemo(() => new Map(nodes.map((node) => [node.name, node])), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const triggers = nodes.filter((node) => !node.disabled && nodeMeta(node.type)?.inputs === 0);
  const draft = useCallback((): Draft | null => (settings ? { nodes, connections, settings } : null), [nodes, connections, settings]);

  const change = (next: { nodes?: WorkflowNode[]; connections?: Connection[] }) => {
    if (next.nodes) setNodes(next.nodes);
    if (next.connections) setConnections(next.connections);
    setDirty(true);
  };

  const flowNodes: CardNode[] = useMemo(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: "wf" as const,
        position: { x: node.position[0], y: node.position[1] },
        data: { node, meta: nodeMeta(node.type), status: run?.nodes[node.name], onOpen: setOpenNode },
        selected: selectedNodes.has(node.id),
        ...(measured[node.id] ? { measured: measured[node.id] } : {}),
      })),
    [nodes, run, selectedNodes, measured],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      connections.flatMap((connection) => {
        const from = byName.get(connection.from.node);
        const to = byName.get(connection.to.node);
        if (!from || !to) return [];
        const edgeId = `${from.id}:${connection.from.output}>${to.id}:${connection.to.input}`;
        const fromStatus = run?.nodes[from.name];
        return [
          {
            id: edgeId,
            source: from.id,
            sourceHandle: `out-${connection.from.output}`,
            target: to.id,
            targetHandle: `in-${connection.to.input}`,
            selected: selectedEdges.has(edgeId),
            animated: fromStatus?.state === "running",
            style: fromStatus?.state === "success" && (fromStatus.counts?.[connection.from.output] ?? 0) > 0 ? { stroke: "var(--c-good)" } : undefined,
            data: { connection },
          },
        ];
      }),
    [connections, byName, run, selectedEdges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      let moved = false;
      const positions = new Map<string, { x: number; y: number }>();
      const removed = new Set<string>();
      const sizes: Record<string, { width: number; height: number }> = {};
      let selection: Set<string> | null = null;
      for (const entry of changes) {
        if (entry.type === "position" && entry.position) {
          positions.set(entry.id, entry.position);
          moved = true;
        } else if (entry.type === "dimensions" && entry.dimensions) {
          sizes[entry.id] = entry.dimensions;
        } else if (entry.type === "select") {
          selection ??= new Set(selectedNodes);
          if (entry.selected) selection.add(entry.id);
          else selection.delete(entry.id);
        } else if (entry.type === "remove") {
          removed.add(entry.id);
        }
      }
      if (Object.keys(sizes).length) setMeasured((current) => ({ ...current, ...sizes }));
      if (selection) setSelectedNodes(selection);
      if (moved) {
        setNodes((current) => current.map((node) => {
          const position = positions.get(node.id);
          return position ? { ...node, position: [Math.round(position.x), Math.round(position.y)] as [number, number] } : node;
        }));
        setDirty(true);
      }
      if (removed.size) {
        const names = new Set([...removed].map((nodeId) => byId.get(nodeId)?.name).filter((value): value is string => Boolean(value)));
        const next = removeNodes(nodes, connections, names);
        change(next);
      }
    },
    [selectedNodes, byId, nodes, connections],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      let selection: Set<string> | null = null;
      const removed = new Set<string>();
      for (const entry of changes) {
        if (entry.type === "select") {
          selection ??= new Set(selectedEdges);
          if (entry.selected) selection.add(entry.id);
          else selection.delete(entry.id);
        } else if (entry.type === "remove") removed.add(entry.id);
      }
      if (selection) setSelectedEdges(selection);
      if (removed.size) {
        const drop = new Set(flowEdges.filter((edge) => removed.has(edge.id)).map((edge) => edge.data?.connection as Connection));
        setConnections((current) => current.filter((connection) => !drop.has(connection)));
        setDirty(true);
      }
    },
    [selectedEdges, flowEdges],
  );

  const toConnection = (value: FlowConnection): Connection | null => {
    const from = byId.get(value.source);
    const to = byId.get(value.target);
    if (!from || !to) return null;
    return { from: { node: from.name, output: Number((value.sourceHandle ?? "out-0").slice(4)) || 0 }, to: { node: to.name, input: Number((value.targetHandle ?? "in-0").slice(3)) || 0 } };
  };

  const onConnect = (value: FlowConnection) => {
    const connection = toConnection(value);
    if (connection) change({ connections: addConnection(nodes, connections, connection) });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || state.fromHandle?.type !== "source") return;
    const from = byId.get(state.fromNode.id);
    if (!from) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    const position = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    setPicker({ position: [position.x, position.y - 30], from: { node: from.name, output: Number((state.fromHandle.id ?? "out-0").slice(4)) || 0 } });
  };

  const addNode = (meta: NodeMeta) => {
    const spot = picker?.position ?? (() => {
      const box = shell.current?.getBoundingClientRect();
      const center = flow.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 800) / 2, y: (box?.top ?? 0) + (box?.height ?? 600) / 2 });
      return [center.x - 96, center.y - 30] as [number, number];
    })();
    const node = createNode(meta, nodes.map((n) => n.name), spot);
    const nextNodes = [...nodes, node];
    const nextConnections = picker?.from ? addConnection(nextNodes, connections, { from: picker.from, to: { node: node.name, input: 0 } }) : connections;
    change({ nodes: nextNodes, connections: nextConnections });
    setPicker(null);
    setSelectedNodes(new Set([node.id]));
    setOpenNode(node.name);
  };

  const save = useCallback(
    async (extra: { active?: boolean } = {}) => {
      if (!workflow || !settings) return null;
      setSaving(true);
      try {
        const { workflow: saved, hooks: urls } = await workflowsApi.save(id, workflow.version, { name: name.trim() || workflow.name, nodes, connections, settings, ...extra });
        setWorkflow(saved);
        setHooks(urls);
        setDirty(false);
        setNotice({ tone: "good", text: extra.active === undefined ? "Saved." : saved.active ? "Saved and activated: schedules and production webhooks now run by themselves." : "Deactivated." });
        return saved;
      } catch (error) {
        setNotice({ tone: "error", text: message(error), reload: error instanceof WorkflowApiError && error.status === 409 });
        return null;
      } finally {
        setSaving(false);
      }
    },
    [workflow, settings, id, name, nodes, connections],
  );

  // Changes made elsewhere (the assistant, MCP, another tab) show up here: a clean editor reloads them, an editor with
  // unsaved changes says so instead of overwriting them.
  const live = useRef({ dirty, version: workflow?.version ?? 0, saving });
  useEffect(() => {
    live.current = { dirty, version: workflow?.version ?? 0, saving };
  });
  useEffect(() => {
    let warned = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || live.current.saving || !live.current.version) return;
      workflowsApi.get(id).then(
        ({ workflow: stored, hooks: urls }) => {
          if (stored.version <= live.current.version) return;
          if (live.current.dirty) {
            if (warned === stored.version) return;
            warned = stored.version;
            setNotice({ tone: "warn", text: "This workflow was changed elsewhere (the assistant or another tab) while you have unsaved changes here.", reload: true });
            return;
          }
          setWorkflow(stored);
          setHooks(urls);
          setName(stored.name);
          setNodes(stored.nodes);
          setConnections(stored.connections);
          setSettings(stored.settings);
          setNotice({ tone: "info", text: "Updated: this workflow was changed elsewhere (the assistant or another tab)." });
        },
        () => undefined,
      );
    }, 3000);
    return () => window.clearInterval(timer);
  }, [id]);

  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const follow = useCallback(
    async (runId: string, signal: AbortSignal) => {
      const statuses: Record<string, NodeStatus> = {};
      let after = 0;
      let final: string | null = null;
      setRun({ runId, status: "running", nodes: {}, record: null });
      for (;;) {
        const page = await workflowsApi.events(id, runId, after, signal);
        for (const event of page.events) {
          if (event.type === "node-start") statuses[event.node] = { state: "running" };
          else if (event.type === "node-end") statuses[event.node] = event.run.error ? { state: "error", error: event.run.error.message } : { state: "success", counts: event.run.outputCounts };
          else if (event.type === "done") final = event.status;
        }
        setRun((current) => ({ ...(current ?? { status: "running", record: null }), runId, nodes: { ...statuses } }) as RunView);
        after = page.next;
        if (page.done || page.unknown) break;
      }
      try {
        const { run: record } = await workflowsApi.getRun(id, runId);
        setRun({ runId, status: record.status as RunView["status"], nodes: statusesFromRecord(record), record, error: record.error?.message });
      } catch {
        setRun((current) => ({ ...(current as RunView), status: (final ?? "success") as RunView["status"] }));
      }
      workflowsApi.runs(id).then((result) => setRuns(result.runs), () => undefined);
    },
    [id],
  );

  const startRun = async (options: { destinationNode?: string; startNode?: string } = {}) => {
    const body = draft();
    if (!body) return;
    const problems = structuralProblems(body);
    if (problems.length) return setNotice({ tone: "error", text: problems[0].message });
    runAbort.current?.abort();
    const controller = new AbortController();
    runAbort.current = controller;
    setNotice(null);
    setRun({ status: "running", nodes: {}, record: null });
    try {
      const start = options.startNode ?? (startTrigger || undefined);
      const { runId } = await workflowsApi.run(id, { draft: body, ...options, ...(start ? { startNode: start } : {}) });
      await follow(runId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setRun((current) => ({ ...(current ?? { nodes: {}, record: null }), status: "error", error: message(error) }) as RunView);
    }
  };

  const stopRun = async () => {
    if (run?.runId) await workflowsApi.cancelRun(id, run.runId).catch(() => undefined);
  };

  const toggleListen = async () => {
    if (listening) {
      listenAbort.current?.abort();
      await workflowsApi.stopListening(id).catch(() => undefined);
      setListening(false);
      return;
    }
    const body = draft();
    if (!body) return;
    const controller = new AbortController();
    listenAbort.current = controller;
    setListening(true);
    setNotice({ tone: "info", text: "Listening: call the test URL now (up to 2 minutes)." });
    try {
      const { runId } = await workflowsApi.listen(id, body, controller.signal);
      setListening(false);
      if (!runId) return setNotice({ tone: "warn", text: "No call arrived. Press Listen again when you are ready." });
      setNotice({ tone: "good", text: "Test call received." });
      runAbort.current?.abort();
      const runController = new AbortController();
      runAbort.current = runController;
      await follow(runId, runController.signal);
    } catch (error) {
      setListening(false);
      if (!controller.signal.aborted) setNotice({ tone: "error", text: message(error) });
    }
  };

  /** Runs also start outside the editor (schedules, production webhooks, the assistant): reload when the list opens. */
  const refreshRuns = () => {
    workflowsApi.runs(id).then((result) => setRuns(result.runs), (error: unknown) => setNotice({ tone: "error", text: message(error) }));
  };

  const showRun = async (runId: string) => {
    try {
      const { run: record } = await workflowsApi.getRun(id, runId);
      setRun({ runId, status: record.status as RunView["status"], nodes: statusesFromRecord(record), record, error: record.error?.message });
      setPanel(null);
    } catch (error) {
      setNotice({ tone: "error", text: message(error) });
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ format: "smart-knife-workflow/1", name, nodes, connections, settings }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(name || "workflow").replace(/[^\w.-]+/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!workflow || !settings) {
    return notice ? (
      <div className="space-y-3">
        <Notice tone="error">{notice.text}</Notice>
        <Button onClick={onBack}>Back to workflows</Button>
      </div>
    ) : (
      <p role="status" className="text-sm text-muted">Loading workflow…</p>
    );
  }

  const open = openNode ? byName.get(openNode) : undefined;
  const openMeta = open ? nodeMeta(open.type) : undefined;
  const running = run?.status === "running";
  const activation = workflow.active ? [] : activationProblems({ nodes, connections });

  return (
    <div ref={shell} className="relative flex h-[calc(100dvh-11rem)] min-h-[520px] flex-col overflow-hidden rounded-tool border border-line bg-surface [&:fullscreen]:h-screen [&:fullscreen]:rounded-none" data-workflow-editor={workflow.id}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Button size="sm" variant="ghost" onClick={() => (!dirty || window.confirm("Leave without saving your changes?")) && onBack()}>
          ← Workflows
        </Button>
        <input
          aria-label="Workflow name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setDirty(true);
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[15px] font-semibold text-ink hover:border-line focus:border-line-strong focus:outline-none sm:max-w-sm"
        />
        {dirty ? <Badge tone="warn">Unsaved</Badge> : null}
        <label className="flex items-center gap-1.5 text-xs text-muted" title={workflow.active ? "Runs by itself (schedules, production webhooks)" : activation[0]?.message ?? "Activate to run by itself"}>
          <input
            type="checkbox"
            role="switch"
            aria-label="Active"
            checked={workflow.active}
            disabled={saving || (!workflow.active && activation.length > 0)}
            onChange={(event) => void save({ active: event.target.checked })}
          />
          Active
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {triggers.length > 1 ? (
            <Select aria-label="Start from" value={startTrigger} onChange={(event) => setStartTrigger(event.target.value)} className="h-7 w-auto text-xs">
              <option value="">Start: default trigger</option>
              {triggers.map((node) => (
                <option key={node.id} value={node.name}>
                  Start: {node.name}
                </option>
              ))}
            </Select>
          ) : null}
          {running ? (
            <Button size="sm" variant="danger" onClick={() => void stopRun()}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={!triggers.length} onClick={() => void startRun()} title={triggers.length ? "Run the workflow as it is now (saved or not)" : "Add a trigger first"}>
              Run workflow
            </Button>
          )}
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPanel("runs");
              refreshRuns();
            }}
          >
            Runs{runs.length ? ` (${runs.length})` : ""}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPanel("settings")}>
            Settings
          </Button>
          <Button size="sm" variant="ghost" onClick={exportJson}>
            Export
          </Button>
          <FullscreenButton target={shell} />
        </div>
      </header>
      {notice || run?.error ? (
        <div className="space-y-1 border-b border-line px-3 py-2">
          {notice ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <Notice tone={notice.tone}>{notice.text}</Notice>
              </div>
              {notice.reload ? <Button size="sm" onClick={() => void load()}>Reload</Button> : null}
            </div>
          ) : null}
          {run?.error && run.status !== "running" ? <Notice tone="error">Run failed: {run.error}</Notice> : null}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1" style={FLOW_STYLE}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={(value) => {
            const connection = toConnection(value as FlowConnection);
            return Boolean(connection && connection.from.node !== connection.to.node && (nodeMeta(byName.get(connection.to.node)?.type ?? "")?.inputs ?? 0) > 0);
          }}
          onNodeDoubleClick={(_, node) => setOpenNode(node.data.node.name)}
          deleteKeyCode={["Backspace", "Delete"]}
          snapToGrid
          snapGrid={[20, 20]}
          minZoom={0.2}
          maxZoom={2}
          fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
          aria-label="Workflow canvas"
        >
          <Background gap={20} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!hidden sm:!block" />
        </ReactFlow>
        {!nodes.length ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="pointer-events-auto max-w-sm rounded-tool border border-dashed border-line-strong bg-surface/90 p-6 text-center">
              <p className="text-sm font-semibold text-ink">Start with a trigger</p>
              <p className="mt-1 text-[13px] text-muted">A manual trigger to run by hand, a schedule, or a webhook another service calls.</p>
              <Button className="mt-3" variant="primary" onClick={() => setPicker({ position: [0, 0] })}>
                Add the first node
              </Button>
            </div>
          </div>
        ) : null}
        <div className="absolute top-3 left-3 flex gap-1.5">
          <Button size="sm" variant="primary" onClick={() => setPicker({ position: (() => {
            const box = shell.current?.getBoundingClientRect();
            const center = flow.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 800) / 2, y: (box?.top ?? 0) + (box?.height ?? 600) / 2 });
            return [center.x - 96, center.y - 30] as [number, number];
          })() })} aria-label="Add a node">
            + Add node
          </Button>
          {run ? (
            <Badge tone={run.status === "success" ? "good" : run.status === "error" ? "danger" : run.status === "running" ? "accent" : "warn"}>
              {run.status === "running" ? "Running…" : `Last run: ${run.status}`}
            </Badge>
          ) : null}
        </div>
      </div>
      {picker ? <NodePicker onPick={addNode} onClose={() => setPicker(null)} triggersOnly={!nodes.length} noTriggers={Boolean(picker.from)} /> : null}
      {open && openMeta ? (
        <NodePanel
          key={open.id}
          node={open}
          meta={openMeta}
          connections={connections}
          record={run?.record ?? null}
          credentials={credentials}
          hooks={hooks}
          running={running}
          listening={listening}
          onChange={(next) => change({ nodes: nodes.map((node) => (node.id === next.id ? next : node)) })}
          onRename={(from, to) => {
            if (nodes.some((node) => node.name === to)) return `A node is already named "${to}".`;
            if (to.length > 80) return "Names have at most 80 characters.";
            const renamed = renameNode(nodes, connections, from, to);
            change(renamed);
            setOpenNode(to);
            return null;
          }}
          onClose={() => setOpenNode(null)}
          onRunNode={(nodeName) => {
            const meta = nodeMeta(byName.get(nodeName)?.type ?? "");
            void startRun(meta?.inputs === 0 ? { startNode: nodeName, destinationNode: nodeName } : { destinationNode: nodeName });
          }}
          onListen={() => void toggleListen()}
          onCredentialCreated={() => workflowsApi.credentials().then((result) => setCredentials(result.credentials), () => undefined)}
        />
      ) : null}
      <Drawer open={panel === "runs"} title="Runs" onClose={() => setPanel(null)} footer={<Button size="sm" onClick={refreshRuns}>Refresh</Button>}>
        {runs.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Run history">
            {runs.map((entry) => (
              <li key={entry.id} className={cx("flex items-center gap-2 px-3 py-2", run?.runId === entry.id && "bg-accent/8")}>
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => void showRun(entry.id)}>
                  <span className="flex items-center gap-2">
                    <Badge tone={entry.status === "success" ? "good" : entry.status === "error" ? "danger" : entry.status === "waiting" ? "warn" : "neutral"}>{entry.status}</Badge>
                    <span className="text-xs text-muted">{entry.mode}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-faint">
                    {new Date(entry.startedAt).toLocaleString("en-GB")}
                    {entry.finishedAt ? ` · ${Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt))} ms` : ""}
                  </span>
                  {entry.error ? <span className="mt-0.5 block truncate text-xs text-danger">{entry.error.message}</span> : null}
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Delete run"
                  onClick={async () => {
                    await workflowsApi.deleteRun(id, entry.id).catch(() => undefined);
                    setRuns((current) => current.filter((item) => item.id !== entry.id));
                  }}
                >
                  ✕
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No runs yet. Press Run workflow, or activate the workflow.</p>
        )}
      </Drawer>
      <Drawer
        open={panel === "settings"}
        title="Workflow settings"
        onClose={() => setPanel(null)}
        footer={
          <Button variant="primary" onClick={() => void save().then((saved) => saved && setPanel(null))}>
            Save settings
          </Button>
        }
      >
        <Field label="Time zone" hint="For schedules and dates in this workflow. Empty = the server's.">
          <TextInput value={settings.timezone ?? ""} placeholder="Europe/Warsaw" onChange={(event) => { setSettings({ ...settings, timezone: event.target.value.trim() || null }); setDirty(true); }} />
        </Field>
        <Field label="Error workflow" hint="Runs when a run of this workflow fails (it needs an Error Trigger).">
          <Select value={settings.errorWorkflow ?? ""} onChange={(event) => { setSettings({ ...settings, errorWorkflow: event.target.value || null }); setDirty(true); }}>
            <option value="">None</option>
            {workflows.filter((entry) => entry.id !== workflow.id && entry.triggers.includes("error")).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Time limit (seconds)" hint="The run stops after this; the instance limit applies too.">
          <TextInput type="number" min={1} max={3600} value={settings.timeoutSeconds ?? ""} placeholder="instance default" onChange={(event) => { setSettings({ ...settings, timeoutSeconds: event.target.value ? Math.max(1, Math.min(3600, Number(event.target.value))) : null }); setDirty(true); }} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.saveSuccessfulRuns} onChange={(event) => { setSettings({ ...settings, saveSuccessfulRuns: event.target.checked }); setDirty(true); }} />
          Keep successful automatic runs in the history
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.saveManualRuns} onChange={(event) => { setSettings({ ...settings, saveManualRuns: event.target.checked }); setDirty(true); }} />
          Keep manual and test runs in the history
        </label>
        <Field label="Other workflows may call this one">
          <Select value={settings.callableBy} onChange={(event) => { setSettings({ ...settings, callableBy: event.target.value as WorkflowSettings["callableBy"] }); setDirty(true); }}>
            <option value="any">Yes (Execute Sub-workflow)</option>
            <option value="none">No</option>
          </Select>
        </Field>
        <Field label="Workflow id" hint="For the Execute Sub-workflow node.">
          <TextArea readOnly rows={1} value={workflow.id} className="font-mono" />
        </Field>
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-[13px] text-muted">Webhook URLs hold a secret token. Anyone with a URL can call it (add auth in the Webhook node to require more).</p>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (!window.confirm("Make new webhook URLs? The current ones stop working at once.")) return;
              try {
                const result = await workflowsApi.rotateToken(id);
                setWorkflow(result.workflow);
                setHooks(result.hooks);
                setNotice({ tone: "good", text: "New webhook URLs made." });
              } catch (error) {
                setNotice({ tone: "error", text: message(error) });
              }
            }}
          >
            New webhook URLs
          </Button>
        </div>
      </Drawer>
    </div>
  );
}

export function Editor(props: { id: string; onBack: () => void }) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}
