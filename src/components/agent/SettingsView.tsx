"use client";

import { msgf } from "@/lib/i18n/msg";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, Notice, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { changeProfile, listModels, probeVisionModels, saveProvider, saveTurnLimits, testProvider } from "@/lib/agent-client/api";
import { UsagePanel } from "./UsagePanel";
import type { AccountInfo, ProviderInput, ProviderModelDetails, VisionProbeResult } from "@/lib/agent-client/types";
import { TURN_LIMIT_BOUNDS } from "@/lib/agent-client/turn-limits";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

/**
 * OpenAI-compatible endpoints people use most. `local` = served on the Knife server's own machine (requests go from the
 * server, not from this browser). `model` pre-fills a default only where the id is stable; otherwise Connect lists the
 * provider's models to pick from.
 */
const PRESETS = [
  { id: "openai", label: msg("OpenAI"), baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: msg("Anthropic"), baseUrl: "https://api.anthropic.com/v1", model: "", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "gemini", label: msg("Gemini"), baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "", keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openrouter", label: msg("OpenRouter"), baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: msg("Groq"), baseUrl: "https://api.groq.com/openai/v1", model: "", keyUrl: "https://console.groq.com/keys" },
  { id: "mistral", label: msg("Mistral"), baseUrl: "https://api.mistral.ai/v1", model: "", keyUrl: "https://console.mistral.ai/api-keys" },
  { id: "deepseek", label: msg("DeepSeek"), baseUrl: "https://api.deepseek.com/v1", model: "", keyUrl: "https://platform.deepseek.com/api_keys" },
  { id: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", model: "", keyUrl: "https://console.x.ai" },
  { id: "ollama", label: msg("Ollama"), baseUrl: "http://localhost:11434/v1", model: "", local: true },
  { id: "lmstudio", label: msg("LM Studio"), baseUrl: "http://localhost:1234/v1", model: "", local: true },
  { id: "custom", label: msg("Custom"), baseUrl: "", model: "" },
] as const satisfies readonly { id: string; label: string; baseUrl: string; model: string; keyUrl?: string; local?: boolean }[];

type Preset = (typeof PRESETS)[number];

function presetFor(baseUrl: string): Preset {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return PRESETS.find((p) => p.baseUrl && p.baseUrl === trimmed) ?? PRESETS[PRESETS.length - 1];
}

/** "Name: value" per line -> object; returns an error string for a bad line. */
function parseHeaders(text: string): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    const value = at > 0 ? line.slice(at + 1).trim() : "";
    if (!name || !value) return { ok: false, error: msgf("Header lines look like \"Name: value\" (got \"{line}\").", { line: line.slice(0, 40) }) };
    headers[name] = value;
  }
  return { ok: true, headers };
}

/** The typed address is not the stored one: the stored key is not offered for it (models list) and is replaced on save. */
function otherAddress(stored: string, typed: string): boolean {
  return stored.replace(/\/+$/, "") !== typed.trim().replace(/\/+$/, "");
}

type Status = { tone: "good" | "error" | "info"; text: string } | null;

interface SettingsProps {
  account: AccountInfo;
  firstRun: boolean;
  onSaved: () => Promise<void>;
  onBack: () => void;
  onLogout: () => Promise<void>;
}

/** Provider settings: how to reach a model (provider, key, model), saved profiles, usage. */
export function SettingsView(props: SettingsProps) {
  const active = props.account.providerProfiles.find((profile) => profile.active)?.id ?? "none";
  // A fresh form per active profile: its fields start from that profile. The status line lives here so it survives the
  // remount (the first save creates the "Default" profile, which changes the key).
  const [status, setStatus] = useState<Status>(null);
  return <ProviderForm key={active} {...props} status={status} setStatus={setStatus} />;
}

/** Saved profiles: switch with the select; New makes one from the form; rename, duplicate and delete sit in a menu. */
function ProfileBar({ account, buildInput, onChanged, setStatus }: { account: AccountInfo; buildInput: () => ProviderInput | string; onChanged: () => Promise<void>; setStatus: (status: Status) => void }) {
  const { t: tr } = useT();
  const profiles = account.providerProfiles;
  const active = profiles.find((profile) => profile.active) ?? null;
  const [naming, setNaming] = useState<null | "new" | "rename">(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [menuOpen]);
  const run = async (work: () => ReturnType<typeof changeProfile>, done: string) => {
    setBusy(true);
    setStatus(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      const f = result.failure;
      setStatus({ tone: "error", text: f.kind === "error" ? f.message : tr("Could not change the profile.") });
      return false;
    }
    setNaming(null);
    setStatus({ tone: "good", text: done });
    await onChanged();
    return true;
  };
  const submitName = async () => {
    const clean = name.trim();
    if (!clean) return setStatus({ tone: "error", text: tr("Give the profile a name.") });
    const input = buildInput();
    if (typeof input === "string") return setStatus({ tone: "error", text: input });
    if (naming === "new") await run(() => changeProfile({ action: "create", name: clean, provider: input, activate: true, ...(active ? { from: active.id } : {}) }), tr("Profile {clean} created and in use.", { clean }));
    else if (naming === "rename" && active) await run(() => changeProfile({ action: "update", id: active.id, name: clean, provider: input }), tr("Saved as {clean}.", { clean }));
  };
  const menuItem = "block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs";
  return (
    <div className="space-y-2" data-provider-profiles>
      <div className="flex items-center gap-1.5">
        <select
          className="sk-input h-8 min-w-0 flex-1 px-2 text-xs"
          aria-label={tr("Provider profile")}
          title={tr("Saved connections. The selected one is the assistant's; workflow AI nodes can use any of them.")}
          value={active?.id ?? ""}
          disabled={busy || profiles.length === 0}
          onChange={(event) => void run(() => changeProfile({ action: "activate", id: event.target.value }), tr("Profile switched: the assistant uses it from the next message."))}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.model}
            </option>
          ))}
        </select>
        <Button size="sm" disabled={busy} onClick={() => { setNaming("new"); setName(""); setMenuOpen(false); }} title={tr("Save the fields below as a new profile")}>
          {tr("New")}
        </Button>
        {active ? (
          <div ref={menuRef} className="relative">
            <Button
              size="sm"
              disabled={busy}
              aria-label={tr("Profile actions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && menuOpen) {
                  event.stopPropagation();
                  setMenuOpen(false);
                }
              }}
            >
              ⋯
            </Button>
            {menuOpen ? (
              <div
                role="menu"
                aria-label={tr("Profile actions")}
                // Escape closes the menu only, not the whole assistant panel.
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  setMenuOpen(false);
                }}
                className="sk-pop absolute top-full right-0 z-20 mt-1 w-36 rounded-lg border border-line-strong bg-surface p-1 shadow-pop"
              >
                <button autoComplete="off" type="button" role="menuitem" className={cx(menuItem, "text-ink hover:bg-raised")} onClick={() => { setNaming("rename"); setName(active.name); setMenuOpen(false); }}>
                  {tr("Rename")}
                </button>
                <button
                  autoComplete="off"
                  type="button"
                  role="menuitem"
                  className={cx(menuItem, "text-ink hover:bg-raised")}
                  onClick={() => {
                    setMenuOpen(false);
                    void run(() => changeProfile({ action: "duplicate", id: active.id, name: `${active.name} copy`.slice(0, 60) }), tr("Copied as {name} copy.", { name: active.name }));
                  }}
                >
                  {tr("Duplicate")}
                </button>
                <button
                  autoComplete="off"
                  type="button"
                  role="menuitem"
                  className={cx(menuItem, "text-danger hover:bg-danger/10")}
                  onClick={() => {
                    setMenuOpen(false);
                    if (window.confirm(tr("Delete the profile {name}? Its key is removed too.", { name: active.name }))) void run(() => changeProfile({ action: "delete", id: active.id }), tr("Deleted {name}.", { name: active.name }));
                  }}
                >
                  {tr("Delete")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {naming ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <TextInput autoFocus aria-label={tr("Profile name")} value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder={tr("e.g. Local LM Studio")} className="h-8 min-w-0 flex-1 text-xs" />
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitName()}>
            {naming === "new" ? tr("Create from the fields below") : tr("Save name")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setNaming(null)}>
            {tr("Cancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProviderForm({
  account,
  firstRun,
  onSaved,
  onBack,
  onLogout,
  status,
  setStatus,
}: SettingsProps & { status: Status; setStatus: (status: Status) => void }) {
  const { t } = useT();
  const { t: tr, m } = useT();
  const provider = account.provider;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PRESETS[0].baseUrl);
  const [model, setModel] = useState(provider?.model ?? PRESETS[0].model);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headersText, setHeadersText] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [effort, setEffort] = useState<"" | "low" | "medium" | "high">(provider?.reasoningEffort ?? "");
  const [vision, setVision] = useState<"native" | "none">(provider?.vision ?? "none");
  const [visionHelper, setVisionHelper] = useState(provider?.visionHelper ?? "");
  const activeProfileId = account.providerProfiles.find((profile) => profile.active)?.id ?? null;
  const helperChoices = account.providerProfiles.filter((profile) => profile.id !== activeProfileId);
  const [working, setWorking] = useState<"connect" | "models" | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelDetails, setModelDetails] = useState<Record<string, ProviderModelDetails>>({});
  /** Vision detection in progress: "one" (Detect for the typed model) or "all" (the model list); stop = Stop pressed. */
  const [probing, setProbing] = useState<"one" | "all" | null>(null);
  const stopProbe = useRef(false);

  const preset = presetFor(baseUrl);
  const local = "local" in preset && preset.local;
  const dirty =
    !provider ||
    baseUrl.trim() !== provider.baseUrl ||
    model.trim() !== provider.model ||
    apiKey !== "" ||
    clearKey ||
    headersText.trim() !== "" ||
    clearHeaders ||
    effort !== (provider?.reasoningEffort ?? "") ||
    vision !== (provider?.vision ?? "none") ||
    visionHelper !== (provider?.visionHelper ?? "");

  function choosePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    const from = presetFor(baseUrl).id;
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    else if (from !== "custom") setBaseUrl("");
    // A model named for another provider rarely exists here: take this one's default (or none: Connect lists them).
    if (from !== p.id || !model.trim()) setModel(p.model);
    setModels([]);
    setStatus(null);
  }

  function buildInput(): ProviderInput | string {
    if (!baseUrl.trim()) return tr("Enter the base URL.");
    if (!model.trim()) return tr("Choose a model.");
    const input: ProviderInput = { baseUrl: baseUrl.trim(), model: model.trim() };
    if (clearKey) input.apiKey = "";
    else if (apiKey !== "") input.apiKey = apiKey;
    const parsed = parseHeaders(headersText);
    if (!parsed.ok) return parsed.error;
    if (Object.keys(parsed.headers).length > 0) input.extraHeaders = parsed.headers;
    else if (clearHeaders) input.extraHeaders = {};
    input.reasoningEffort = effort;
    input.vision = vision;
    input.visionHelper = visionHelper;
    return input;
  }

  /** The models the provider lists for the fields as typed (nothing is saved). */
  async function loadModels(): Promise<boolean> {
    const fields = connectionFields();
    if (typeof fields === "string") {
      setStatus({ tone: "error", text: fields });
      return false;
    }
    const result = await listModels(fields);
    if (!result.ok) {
      setStatus({ tone: "error", text: result.failure.kind === "error" ? result.failure.message : tr("Could not list the models.") });
      return false;
    }
    const t = result.value;
    if (!t.ok) {
      setStatus({ tone: "error", text: tr("The provider did not answer{value}{value2}", { value: t.status ? ` (HTTP ${t.status})` : "", value2: t.error ? `: ${t.error}` : "." }) });
      return false;
    }
    const list = t.models ?? [];
    setModels(list);
    setModelDetails(Object.fromEntries((t.modelDetails ?? []).map((entry) => [entry.id, entry])));
    if (!list.length) {
      setStatus({ tone: "info", text: tr("The provider lists no models: type the model name.") });
      return false;
    }
    return true;
  }

  /** Connect: save what changed, then test it (GET /models), which also fills the model list. */
  async function connect(event?: FormEvent) {
    event?.preventDefault();
    if (working) return;
    setStatus(null);
    if (!model.trim()) {
      setWorking("models");
      const listed = await loadModels();
      setWorking(null);
      if (listed) setStatus({ tone: "info", text: tr("Choose a model, then press Connect.") });
      return;
    }
    const input = buildInput();
    if (typeof input === "string") return setStatus({ tone: "error", text: input });
    setWorking("connect");
    const changed = dirty;
    if (changed) {
      const saved = await saveProvider(input);
      if (!saved.ok) {
        setWorking(null);
        const f = saved.failure;
        return setStatus({ tone: "error", text: f.kind === "error" ? f.message : tr("Could not save the settings.") });
      }
      setApiKey("");
      setClearKey(false);
      setHeadersText("");
      setClearHeaders(false);
    }
    const tested = await testProvider();
    setWorking(null);
    const saved = changed ? " Saved." : "";
    if (!tested.ok) {
      const f = tested.failure;
      const why = f.kind === "error" ? m(f.message) : tr("no answer.");
      setStatus({ tone: "error", text: saved ? tr("Saved, but the test failed: {why}", { why }) : tr("The test failed: {why}", { why }) });
    } else if (!tested.value.ok) {
      const result = tested.value;
      const why = `${result.status ? ` (HTTP ${result.status})` : ""}${result.error ? `: ${m(result.error)}` : "."}`;
      setStatus({ tone: "error", text: saved ? tr("Saved, but the provider did not answer{why}", { why }) : tr("The provider did not answer{why}", { why }) });
    } else {
      const t = tested.value;
      if (t.models?.length) setModels(t.models);
      if (t.modelDetails) setModelDetails(Object.fromEntries(t.modelDetails.map((entry) => [entry.id, entry])));
      const unknown = t.models?.length && !t.models.includes(model.trim()) ? tr(" The provider does not list {trim}: check the name.", { trim: model.trim() }) : "";
      setStatus({ tone: unknown ? "info" : "good", text: `Connected${t.modelCount !== undefined ? ` (${t.modelCount} models listed)` : ""}.${saved}${unknown}` });
      if (changed) await onSaved();
      if (firstRun && !unknown) onBack();
      return;
    }
    if (changed) await onSaved();
  }

  /** The typed connection fields for the model-list and probe routes (the stored key only for the stored address). */
  function connectionFields(): { baseUrl: string; apiKey?: string; extraHeaders?: Record<string, string> } | string {
    if (!baseUrl.trim()) return tr("Enter the base URL.");
    const parsed = parseHeaders(headersText);
    if (!parsed.ok) return parsed.error;
    return {
      baseUrl: baseUrl.trim(),
      ...(clearKey ? { apiKey: "" } : apiKey !== "" ? { apiKey } : {}),
      ...(Object.keys(parsed.headers).length > 0 ? { extraHeaders: parsed.headers } : {}),
    };
  }

  /** Learned answers into the model details (a model the provider does not list gets an entry of its own). */
  function mergeProbe(results: VisionProbeResult[]) {
    setModelDetails((previous) => {
      const next = { ...previous };
      for (const result of results) {
        if (result.vision === null) continue;
        const base = next[result.model] ?? { id: result.model, contextLength: null, vision: null, visionSource: null, features: [] };
        next[result.model] = { ...base, vision: result.vision, visionSource: "detected", ...(result.checkedAt ? { visionCheckedAt: result.checkedAt } : {}) };
      }
      return next;
    });
  }

  /** One sentence for one model's probe answer. */
  function probeText(result: VisionProbeResult): string {
    const id = result.model;
    const date = result.checkedAt ? result.checkedAt.slice(0, 10) : "";
    switch (result.reason) {
      case "saw":
        return tr("{id} sees images: it named the colours of a test picture.", { id });
      case "rejected":
        return tr("{id} is text only: the provider refused the test picture (HTTP {status}).", { id, status: String(result.status ?? "") });
      case "no_image":
        return tr("{id} is text only: it answered that it got no image.", { id });
      case "cached":
        return result.vision ? tr("{id} sees images (checked on {date}).", { id, date }) : tr("{id} is text only (checked on {date}).", { id, date });
      case "unclear":
        return tr("Could not tell whether {id} sees images: its answer was unclear. Try again or choose by hand.", { id });
      case "rate_limited":
        return tr("Too many requests: check {id} again later.", { id });
      case "error":
        return result.status
          ? tr("Could not test {id} (HTTP {status}). Nothing was remembered.", { id, status: String(result.status) })
          : tr("Could not test {id}: no answer. Nothing was remembered.", { id });
    }
  }

  /** Detect: ask the typed model with a tiny test picture; a definite answer sets "Sees images" (saved with Connect). */
  async function detectVision() {
    const id = model.trim();
    if (!id) return setStatus({ tone: "error", text: tr("Choose a model.") });
    const fields = connectionFields();
    if (typeof fields === "string") return setStatus({ tone: "error", text: fields });
    setProbing("one");
    setStatus({ tone: "info", text: tr("Sending {id} a tiny test picture…", { id }) });
    const result = await probeVisionModels({ ...fields, models: [id], force: modelDetails[id]?.visionSource === "detected" });
    setProbing(null);
    if (!result.ok) return setStatus({ tone: "error", text: result.failure.kind === "error" ? m(result.failure.message) : tr("Could not test the model.") });
    const answer = result.value[0];
    if (!answer) return setStatus({ tone: "error", text: tr("Could not test the model.") });
    mergeProbe(result.value);
    if (answer.vision !== null) setVision(answer.vision ? "native" : "none");
    const changed = answer.vision !== null && (answer.vision ? "native" : "none") !== (provider?.vision ?? "none");
    setStatus({ tone: answer.vision === null ? "error" : "good", text: changed ? `${probeText(answer)} ${tr("Press Connect to save it.")}` : probeText(answer) });
  }

  /** Check all: every listed model whose vision is still unknown, a few at a time (at most 60 per press). */
  async function detectAll() {
    const fields = connectionFields();
    if (typeof fields === "string") return setStatus({ tone: "error", text: fields });
    const todo = models.filter((id) => (modelDetails[id]?.vision ?? null) === null).slice(0, 60);
    if (!todo.length) return setStatus({ tone: "info", text: tr("Every listed model already has a known vision answer.") });
    stopProbe.current = false;
    setProbing("all");
    const counts = { yes: 0, no: 0, unknown: 0 };
    let done = 0;
    for (let at = 0; at < todo.length && !stopProbe.current; at += 3) {
      setStatus({ tone: "info", text: tr("Checking models for vision: {done} of {total}…", { done: String(done), total: String(todo.length) }) });
      const batch = todo.slice(at, at + 3);
      const result = await probeVisionModels({ ...fields, models: batch });
      if (!result.ok) {
        setProbing(null);
        return setStatus({ tone: "error", text: result.failure.kind === "error" ? m(result.failure.message) : tr("Could not test the model.") });
      }
      mergeProbe(result.value);
      for (const answer of result.value) counts[answer.vision === null ? "unknown" : answer.vision ? "yes" : "no"] += 1;
      done += batch.length;
    }
    setProbing(null);
    setStatus({ tone: "good", text: tr("Vision check done ({done} models). Sees images: {yes}. Text only: {no}. Unknown: {unknown}.", { done: String(done), yes: String(counts.yes), no: String(counts.no), unknown: String(counts.unknown) }) });
  }

  const current = modelDetails[model.trim()];
  const visionNote = !current || current.vision === null
    ? tr("Not known whether this model sees images. Detect asks it with a tiny test picture (one small request).")
    : current.visionSource === "advertised"
      ? current.vision ? tr("The provider lists this model as seeing images.") : tr("The provider lists this model as text only.")
      : current.vision
        ? tr("Detected on {date}: sees images.", { date: (current.visionCheckedAt ?? "").slice(0, 10) })
        : tr("Detected on {date}: text only.", { date: (current.visionCheckedAt ?? "").slice(0, 10) });

  const keyPlaceholder =
    provider?.hasKey && !otherAddress(provider.baseUrl, baseUrl)
      ? tr("Stored key {value} (leave blank to keep)", { value: provider.keyHint ?? "••••" })
      : local
        ? tr("Usually not needed for a local server")
        : tr("Paste the API key");

  return (
    <form onSubmit={connect} className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4" aria-label={tr("Provider settings")}>
      {firstRun ? <p className="text-[13px] leading-snug text-muted">{tr("Connect a model to start: pick a provider, paste its key, choose a model. The key stays on this server.")}</p> : null}

      {account.providerProfiles.length > 0 ? <ProfileBar account={account} buildInput={buildInput} onChanged={onSaved} setStatus={setStatus} /> : null}

      <div role="group" aria-label={tr("Provider preset")} className="grid grid-cols-3 gap-1.5 max-[340px]:grid-cols-2">
        {PRESETS.map((p) => (
          <button
            autoComplete="off"
            key={p.id}
            type="button"
            aria-pressed={preset.id === p.id}
            onClick={() => choosePreset(p.id)}
            className={cx(
              "min-w-0 cursor-pointer truncate rounded-lg border px-2 py-1.5 text-xs transition-colors",
              preset.id === p.id ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {t(p.label)}
          </button>
        ))}
      </div>

      <Field label={tr("Base URL")} hint={local ? tr("Runs on the Knife server's machine: requests come from the server, not from this browser.") : preset.id === "custom" ? tr("Any OpenAI-compatible API, usually ending in /v1.") : undefined}>
        <TextInput
          data-agent-autofocus
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setModels([]);
          }}
          placeholder={tr("https://…/v1")}
        />
      </Field>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="sk-provider-key" className="sk-label">
            {tr("API key")}
          </label>
          {"keyUrl" in preset ? (
            <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] whitespace-nowrap text-accent-soft underline underline-offset-2 hover:text-ink">
              {tr("Get your {label} key ↗", { label: preset.label })}
            </a>
          ) : null}
        </div>
        <TextInput id="sk-provider-key" type="password" autoComplete="new-password" value={apiKey} disabled={clearKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyPlaceholder} />
        <p className="text-[11px] text-faint">{tr("Write-only: kept on the server, never shown again.")}</p>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="sk-provider-model" className="sk-label">
            {tr("Model")}
          </label>
          <button
            autoComplete="off"
            type="button"
            disabled={working !== null}
            onClick={async () => {
              setStatus(null);
              setWorking("models");
              await loadModels();
              setWorking(null);
            }}
            className="cursor-pointer text-[11px] whitespace-nowrap text-accent-soft underline underline-offset-2 hover:text-ink disabled:cursor-default disabled:opacity-50"
          >
            {working === "models" ? tr("Loading models…") : models.length ? tr("Reload models") : tr("Load models")}
          </button>
        </div>
        <TextInput id="sk-provider-model" autoComplete="off" spellCheck={false} value={model} onChange={(e) => setModel(e.target.value)} placeholder={tr("Model name, or Load models")} list={models.length ? "sk-provider-models" : undefined} />
        {models.length ? (
          <>
            <datalist id="sk-provider-models">
              {models.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <select aria-label={tr("Available models")} className="sk-input h-8 w-full px-2 text-xs" value={models.includes(model) ? model : ""} onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              setModel(id);
              const details = modelDetails[id];
              if (details?.vision === true) setVision("native");
              else if (details?.vision === false) setVision("none");
            }}>
              <option value="">{models.length} {" "}{tr("models available: pick one…")}</option>
              {models.map((id) => {
                const details = modelDetails[id];
                const visionLabel = !details || details.vision === null
                  ? tr("vision unknown")
                  : details.visionSource === "detected"
                    ? details.vision ? tr("vision (detected)") : tr("text only (detected)")
                    : details.vision ? tr("vision") : tr("text only");
                const capabilities = details
                  ? ` · ${details.contextLength ? `${details.contextLength.toLocaleString()} ctx` : tr("context unknown")} · ${visionLabel}${details.features.length ? ` · ${details.features.join(", ")}` : ""}`
                  : "";
                return <option key={id} value={id}>{id}{capabilities}</option>;
              })}
            </select>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {modelDetails[model] ? (
                <p className="min-w-0 text-[11px] text-faint" aria-live="polite">
                  {tr("Context: {value}", { value: modelDetails[model].contextLength?.toLocaleString() ?? tr("not advertised") })}
                  {modelDetails[model].features.length ? ` · ${tr("Features")}: ${modelDetails[model].features.join(", ")}` : ""}
                </p>
              ) : <p className="min-w-0 text-[11px] text-faint">{models.includes(model) ? tr("This provider does not advertise model capabilities.") : ""}</p>}
              {probing === "all" ? (
                <button autoComplete="off" type="button" onClick={() => { stopProbe.current = true; }} className="cursor-pointer text-[11px] whitespace-nowrap text-accent-soft underline underline-offset-2 hover:text-ink">
                  {tr("Stop checking")}
                </button>
              ) : (
                <button
                  autoComplete="off"
                  type="button"
                  disabled={working !== null || probing !== null}
                  onClick={() => void detectAll()}
                  title={tr("Sends every model whose vision is unknown a tiny test picture (one small request each) and remembers the answers.")}
                  className="cursor-pointer text-[11px] whitespace-nowrap text-accent-soft underline underline-offset-2 hover:text-ink disabled:cursor-default disabled:opacity-50"
                  data-provider-check-all
                >
                  {tr("Check all models for vision")}
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="space-y-1.5 rounded-lg border border-line px-3 py-2" data-provider-vision>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="sk-provider-vision" className="min-w-0 text-xs text-muted">
            {tr("Vision: screenshots and images")}
          </label>
          <div className="flex shrink-0 items-center gap-1.5">
            <select id="sk-provider-vision" className="sk-input h-8 px-2 text-xs" value={vision} onChange={(e) => setVision(e.target.value === "native" ? "native" : "none")} aria-label={tr("Does this model see images?")}>
              <option value="none">{tr("Text only")}</option>
              <option value="native">{tr("Sees images")}</option>
            </select>
            <Button size="sm" disabled={working !== null || probing !== null || !model.trim()} onClick={() => void detectVision()} data-provider-detect title={tr("Send the model one tiny test picture to find out whether it sees images.")}>
              {probing === "one" ? tr("Detecting…") : current?.visionSource === "detected" ? tr("Check again") : tr("Detect")}
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-faint" data-provider-vision-note>{visionNote}</p>
        <p className="text-[11px] text-faint">{tr("Only a model that sees images is sent pictures; a text-only one never is.")}</p>
      </div>

      <details className="rounded-lg border border-line px-3 py-2" open={Boolean(provider?.extraHeaderNames.length || provider?.reasoningEffort)}>
        <summary className="cursor-pointer text-xs text-muted select-none">{tr("Advanced: reasoning effort, extra headers")}</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span className="min-w-0">
              {tr("Reasoning effort")}
              <span className="block text-[11px] text-faint">{tr("Sent as reasoning_effort, if the model takes it.")}</span>
            </span>
            <select className="sk-input h-8 shrink-0 px-2 text-xs" value={effort} onChange={(e) => setEffort(e.target.value as "" | "low" | "medium" | "high")} aria-label={tr("Reasoning effort")}>
              <option value="">{tr("Provider default")}</option>
              <option value="low">{tr("Low")}</option>
              <option value="medium">{tr("Medium")}</option>
              <option value="high">{tr("High")}</option>
            </select>
          </label>
          <div className="space-y-1.5">
            <p className="text-xs text-muted">
              {tr("Extra headers")}
              {provider?.extraHeaderNames.length ? <span className="text-faint"> {" "}{tr("· stored: {value} (values hidden)", { value: provider.extraHeaderNames.join(", ") })}</span> : null}
            </p>
            <TextArea
              rows={2}
              spellCheck={false}
              autoComplete="off"
              value={headersText}
              onChange={(e) => setHeadersText(e.target.value)}
              placeholder={tr("HTTP-Referer: https://example.com\nX-Title: My app")}
              aria-label={tr("Extra headers, one Name: value per line")}
              className="text-xs"
            />
            {provider?.extraHeaderNames.length ? (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} />
                {tr("Remove the stored headers (unless new ones are entered)")}
              </label>
            ) : null}
          </div>
          {provider?.hasKey ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
              {tr("Remove the stored key")}
            </label>
          ) : null}
        </div>
      </details>

      <details className="rounded-lg border border-line px-3 py-2" open={Boolean(provider?.visionHelper)} data-provider-vision-helper>
        <summary className="cursor-pointer text-xs text-muted select-none">{tr("Vision helper for a text-only model")}</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span className="min-w-0">
              {tr("Vision helper")}
              <span className="block text-[11px] text-faint">{tr("Another saved profile with a vision model: it describes screenshots in words for this one.")}</span>
            </span>
            <select className="sk-input h-8 max-w-[11rem] shrink-0 px-2 text-xs" value={visionHelper} onChange={(e) => setVisionHelper(e.target.value)} aria-label={tr("Vision helper")} disabled={helperChoices.length === 0 && !visionHelper}>
              <option value="">{tr("None")}</option>
              {helperChoices.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.model}
                </option>
              ))}
            </select>
          </label>
          {helperChoices.length === 0 ? <p className="text-[11px] text-faint">{tr("To use a helper, save a second profile with a vision model (for example a GPT, Gemini or Qwen-VL model) first.")}</p> : null}
        </div>
      </details>

      {status ? (
        <div role="status">
          <Notice tone={status.tone}>{status.text}</Notice>
        </div>
      ) : null}

      <Button type="submit" variant="primary" disabled={working !== null} className="w-full justify-center">
        {working === "connect" ? tr("Connecting…") : working === "models" ? tr("Loading models…") : dirty ? tr("Connect") : tr("Test the connection")}
      </Button>

      <p className="text-[11px] leading-snug text-faint">
        {tr("Chat history is kept on this server per account, provider, and conversation; the action journal keeps page paths and tool names only. Clear conversation deletes it.")}
      </p>

      {!firstRun ? <TurnLimitPanel account={account} onSaved={onSaved} /> : null}

      {!firstRun ? (
        <details className="rounded-lg border border-line px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted select-none">{tr("Token usage")}</summary>
          <div className="mt-2">
            <UsagePanel />
          </div>
        </details>
      ) : null}

      {account.requiresPassword ? (
        <div className="border-t border-line pt-3">
          <Button variant="danger" size="sm" onClick={() => void onLogout()}>
            {tr("Log out {displayName}", { displayName: account.displayName })}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

/**
 * Turn limit: how many model rounds one message may take and how many tool calls they may make together, before the
 * assistant stops and summarises. Saved on the account at once (its own Save, not the provider's Connect).
 */
function TurnLimitPanel({ account, onSaved }: { account: AccountInfo; onSaved: () => Promise<void> }) {
  const { t: tr, m } = useT();
  const saved = account.assistant;
  const [rounds, setRounds] = useState(String(saved.maxRounds));
  const [calls, setCalls] = useState(String(saved.maxToolCalls));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Status>(null);
  const bounds = TURN_LIMIT_BOUNDS;
  const roundsValue = Number(rounds);
  const callsValue = Number(calls);
  const valid =
    Number.isInteger(roundsValue) && roundsValue >= bounds.maxRounds.min && roundsValue <= bounds.maxRounds.max &&
    Number.isInteger(callsValue) && callsValue >= bounds.maxToolCalls.min && callsValue <= bounds.maxToolCalls.max;
  const changed = roundsValue !== saved.maxRounds || callsValue !== saved.maxToolCalls;
  const save = async (reset: boolean) => {
    setBusy(true);
    setNote(null);
    const result = await saveTurnLimits(reset ? null : { maxRounds: roundsValue, maxToolCalls: callsValue });
    setBusy(false);
    if (!result.ok) return setNote({ tone: "error", text: result.failure.kind === "error" ? m(result.failure.message) : tr("Could not save the turn limit.") });
    if (reset) {
      setRounds(String(bounds.maxRounds.default));
      setCalls(String(bounds.maxToolCalls.default));
    }
    setNote({ tone: "good", text: tr("Turn limit saved: it applies from the next message.") });
    await onSaved();
  };
  return (
    <details className="rounded-lg border border-line px-3 py-2" data-turn-limit open={saved.custom || undefined}>
      <summary className="cursor-pointer text-xs text-muted select-none">
        {tr("Turn limit: {rounds} model rounds, {calls} tool calls per message", { rounds: String(saved.maxRounds), calls: String(saved.maxToolCalls) })}
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11px] leading-snug text-faint">
          {tr("One message to the assistant may take several model rounds (each round can call tools). When either limit is reached, the assistant stops and summarises what is done and what is left. Higher limits allow longer jobs and cost more tokens.")}
        </p>
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span className="min-w-0">
            {tr("Model rounds per message")}
            <span className="block text-[11px] text-faint">{tr("From {min} to {max}; default {value}.", { min: String(bounds.maxRounds.min), max: String(bounds.maxRounds.max), value: String(bounds.maxRounds.default) })}</span>
          </span>
          <TextInput type="number" inputMode="numeric" min={bounds.maxRounds.min} max={bounds.maxRounds.max} step={1} value={rounds} onChange={(e) => setRounds(e.target.value)} aria-label={tr("Model rounds per message")} className="h-8 w-20 shrink-0 text-xs" />
        </label>
        <label className="flex items-center justify-between gap-3 text-xs text-muted">
          <span className="min-w-0">
            {tr("Tool calls per message")}
            <span className="block text-[11px] text-faint">{tr("From {min} to {max}; default {value}.", { min: String(bounds.maxToolCalls.min), max: String(bounds.maxToolCalls.max), value: String(bounds.maxToolCalls.default) })}</span>
          </span>
          <TextInput type="number" inputMode="numeric" min={bounds.maxToolCalls.min} max={bounds.maxToolCalls.max} step={1} value={calls} onChange={(e) => setCalls(e.target.value)} aria-label={tr("Tool calls per message")} className="h-8 w-20 shrink-0 text-xs" />
        </label>
        {!valid ? <p className="text-[11px] text-danger">{tr("Enter whole numbers within the limits shown.")}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="primary" disabled={busy || !valid || !changed} onClick={() => void save(false)}>
            {tr("Save turn limit")}
          </Button>
          {saved.custom ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>
              {tr("Back to the defaults")}
            </Button>
          ) : null}
        </div>
        {note ? (
          <div role="status">
            <Notice tone={note.tone}>{note.text}</Notice>
          </div>
        ) : null}
      </div>
    </details>
  );
}
