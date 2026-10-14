"use client";

import { useState, type FormEvent } from "react";
import { Button, Field, Notice, TextArea, TextInput } from "@/components/ui";
import { cx } from "@/lib/format";
import { saveProvider, testProvider } from "@/lib/agent-client/api";
import { openClawResponsesProblem } from "@/lib/accounts/openclaw-target";
import { UsagePanel } from "./UsagePanel";
import type { AccountInfo, ProviderInput } from "@/lib/agent-client/types";

const PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  { id: "custom", label: "Custom", baseUrl: "", model: "" },
] as const;

function presetFor(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return PRESETS.find((p) => p.baseUrl && p.baseUrl === trimmed)?.id ?? "custom";
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
    if (!name || !value) return { ok: false, error: `Header lines look like "Name: value" (got "${line.slice(0, 40)}").` };
    headers[name] = value;
  }
  return { ok: true, headers };
}

type Status = { tone: "good" | "error" | "info"; text: string } | null;

export function SettingsView({
  account,
  firstRun,
  onSaved,
  onBack,
  onLogout,
}: {
  account: AccountInfo;
  firstRun: boolean;
  onSaved: () => Promise<void>;
  onBack: () => void;
  onLogout: () => Promise<void>;
}) {
  const provider = account.provider;
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PRESETS[0].baseUrl);
  const [model, setModel] = useState(provider?.model ?? PRESETS[0].model);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headersText, setHeadersText] = useState("");
  const [clearHeaders, setClearHeaders] = useState(false);
  const [effort, setEffort] = useState<"" | "low" | "medium" | "high">(provider?.reasoningEffort ?? "");
  const [openClawResponses, setOpenClawResponses] = useState(provider?.openClawResponses ?? false);
  const [status, setStatus] = useState<Status>(null);
  const [working, setWorking] = useState<"save" | "test" | null>(null);

  const preset = presetFor(baseUrl);
  const dirty =
    !provider ||
    baseUrl.trim() !== provider.baseUrl ||
    model.trim() !== provider.model ||
    apiKey !== "" ||
    clearKey ||
    headersText.trim() !== "" ||
    clearHeaders ||
    effort !== (provider?.reasoningEffort ?? "") ||
    openClawResponses !== (provider?.openClawResponses ?? false);

  function choosePreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    else if (presetFor(baseUrl) !== "custom") setBaseUrl("");
    if (p.model && (!model.trim() || PRESETS.some((x) => x.model === model))) setModel(p.model);
  }

  function buildInput(): ProviderInput | string {
    if (!baseUrl.trim()) return "Enter a base URL.";
    if (!model.trim()) return "Enter a model name.";
    const responsesProblem = openClawResponses ? openClawResponsesProblem(baseUrl, model) : null;
    if (responsesProblem) return responsesProblem;
    const input: ProviderInput = { baseUrl: baseUrl.trim(), model: model.trim() };
    if (clearKey) input.apiKey = "";
    else if (apiKey !== "") input.apiKey = apiKey;
    const parsed = parseHeaders(headersText);
    if (!parsed.ok) return parsed.error;
    if (Object.keys(parsed.headers).length > 0) input.extraHeaders = parsed.headers;
    else if (clearHeaders) input.extraHeaders = {};
    input.reasoningEffort = effort;
    input.openClawResponses = openClawResponses;
    return input;
  }

  async function persist(): Promise<boolean> {
    const input = buildInput();
    if (typeof input === "string") {
      setStatus({ tone: "error", text: input });
      return false;
    }
    const result = await saveProvider(input);
    if (!result.ok) {
      const f = result.failure;
      setStatus({ tone: "error", text: f.kind === "error" ? f.message : "Could not save settings." });
      return false;
    }
    setApiKey("");
    setClearKey(false);
    setHeadersText("");
    setClearHeaders(false);
    await onSaved();
    return true;
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (working) return;
    setWorking("save");
    setStatus(null);
    const saved = await persist();
    setWorking(null);
    if (saved) setStatus({ tone: "good", text: "Saved." });
  }

  async function test() {
    if (working) return;
    setWorking("test");
    setStatus(null);
    if (dirty && !(await persist())) {
      setWorking(null);
      return;
    }
    const result = await testProvider();
    setWorking(null);
    if (!result.ok) {
      const f = result.failure;
      setStatus({ tone: "error", text: f.kind === "provider_not_configured" ? "Save the provider first." : f.kind === "error" ? f.message : "Test failed." });
      return;
    }
    const t = result.value;
    setStatus(
      t.ok
        ? { tone: "good", text: `Connected${t.modelCount !== undefined ? ` (${t.modelCount} models listed)` : ""}.` }
        : { tone: "error", text: `Connection failed${t.status ? ` (HTTP ${t.status})` : ""}${t.error ? `: ${t.error}` : "."}` },
    );
  }

  const keyPlaceholder = provider?.hasKey ? `Stored key ${provider.keyHint ?? "••••"} (leave blank to keep)` : "Paste API key (optional for local servers)";

  return (
    <form onSubmit={save} className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto p-4" aria-label="Provider settings">
      {firstRun ? <Notice tone="info">Connect a model provider (any OpenAI-compatible API) to start. Your key stays on the server.</Notice> : null}
      <Notice tone="info">Conversation history is saved on this Knife server per account and provider. The compact action journal stores page paths and tool names, not field values or file names. Clear conversation removes the saved history and starts a fresh OpenClaw session.</Notice>

      <div role="group" aria-label="Provider preset" className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            autoComplete="off"
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            onClick={() => choosePreset(p.id)}
            className={cx(
              "cursor-pointer rounded-lg border px-2.5 py-1 text-xs transition-colors",
              preset === p.id ? "border-accent/60 bg-accent/10 text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <Field label="Base URL" hint="OpenAI-compatible, e.g. https://api.openai.com/v1">
        <TextInput
          data-agent-autofocus
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://…/v1"
        />
      </Field>
      <Field label="Model">
        <TextInput autoComplete="off" spellCheck={false} value={model} onChange={(e) => setModel(e.target.value)} placeholder="model name" />
      </Field>
      <Field label="API key" hint="Write-only: stored on the server and never shown again.">
        <TextInput
          type="password"
          autoComplete="new-password"
          value={apiKey}
          disabled={clearKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyPlaceholder}
        />
      </Field>
      {provider?.hasKey ? (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />
          Remove the stored key
        </label>
      ) : null}

      <details className="rounded-lg border border-line px-3 py-2" open={Boolean(provider?.extraHeaderNames.length || provider?.reasoningEffort || provider?.openClawResponses)}>
        <summary className="cursor-pointer text-xs text-muted select-none">Extra headers and advanced (optional)</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-center justify-between gap-2 text-xs text-muted">
            Reasoning effort
            <select
              className="sk-input px-2 py-1 text-xs"
              value={effort}
              onChange={(e) => setEffort(e.target.value as "" | "low" | "medium" | "high")}
              aria-label="Reasoning effort"
            >
              <option value="">Provider default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <p className="text-xs text-faint">Sent as reasoning_effort; only set it if your provider accepts it.</p>
          <label className="flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" checked={openClawResponses} onChange={(e) => setOpenClawResponses(e.target.checked)} />
            <span><span className="block text-ink">Use OpenClaw Responses continuation</span><span className="text-faint">For an OpenClaw gateway configured at /v1 with model openclaw/&lt;agent&gt;. Uses delta-only turns and one durable gateway session.</span></span>
          </label>
          {provider?.extraHeaderNames.length ? (
            <p className="text-xs text-faint">Stored: {provider.extraHeaderNames.join(", ")} (values hidden).</p>
          ) : null}
          <TextArea
            rows={3}
            spellCheck={false}
            autoComplete="off"
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder={"HTTP-Referer: https://example.com\nX-Title: My app"}
            aria-label="Extra headers, one Name: value per line"
          />
          {provider?.extraHeaderNames.length ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={clearHeaders} onChange={(e) => setClearHeaders(e.target.checked)} />
              Remove stored headers (unless new ones are entered)
            </label>
          ) : null}
        </div>
      </details>

      {status ? (
        <div role="status">
          <Notice tone={status.tone}>{status.text}</Notice>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" disabled={working !== null}>
          {working === "save" ? "Saving…" : "Save"}
        </Button>
        <Button onClick={test} disabled={working !== null}>
          {working === "test" ? "Testing…" : "Test connection"}
        </Button>
        {!firstRun ? (
          <Button variant="ghost" onClick={onBack}>
            Back to chat
          </Button>
        ) : null}
      </div>

      {!firstRun ? <UsagePanel /> : null}

      {account.requiresPassword ? (
        <div className="border-t border-line pt-3">
          <Button variant="danger" size="sm" onClick={() => void onLogout()}>
            Log out {account.displayName}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
