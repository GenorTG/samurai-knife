"use client";

/**
 * Workflow credentials (docs/WORKFLOWS.md "Rules"): API keys, tokens, logins and OAuth2 connections with the user's own
 * app. Stored sealed in the account; after saving, secrets come back only as "set". OAuth2: save, then Connect (a popup
 * to the provider; the token lands on the server).
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ButtonLink, EmptyState, Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import { workflowsApi, type PublicCredential } from "@/lib/workflows/client";
import { CREDENTIAL_TYPES, credentialType, oauthPreset, type CredentialField } from "@/lib/workflows/credential-types";
import { useT } from "@/lib/i18n/react";
import { CREDENTIAL_RECIPES, credentialDefaults, credentialRecipe, recipeValues } from "@/lib/workflows/credential-recipes";

function redirectUri(): string {
  return typeof window === "undefined" ? "" : `${window.location.origin}/api/workflows/oauth/callback`;
}

export function CredentialForm({
  initial,
  allowedTypes,
  onSaved,
  onCancel,
}: {
  initial?: PublicCredential;
  /** Restrict the type list (a node slot's types). */
  allowedTypes?: string[];
  onSaved: (credential: PublicCredential) => void;
  onCancel?: () => void;
}) {
  const { t } = useT();
  const types = CREDENTIAL_TYPES.filter((type) => !allowedTypes || allowedTypes.includes(type.type));
  const [type, setType] = useState(initial?.type ?? types[0]?.type ?? "httpHeaderAuth");
  const [name, setName] = useState(initial?.name ?? "");
  const [recipeId, setRecipeId] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const out: Record<string, string | boolean> = credentialDefaults(initial?.type ?? types[0]?.type ?? "httpHeaderAuth");
    for (const [key, value] of Object.entries(initial?.fields ?? {})) if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    return out;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = credentialType(type);
  const preset = type === "oAuth2Api" ? oauthPreset(values.preset ?? "google") : undefined;
  const secretSet = (field: CredentialField) => initial?.fields[field.name] === true;
  const recipe = credentialRecipe(recipeId);
  const recipes = CREDENTIAL_RECIPES.filter((entry) => types.some((candidate) => candidate.type === entry.type));

  const setField = (field: string, value: string | boolean) => {
    setValues((current) => {
      const next = { ...current, [field]: value };
      if (field === "preset" && typeof value === "string") {
        const chosen = oauthPreset(value);
        if (chosen && chosen.id !== "custom") Object.assign(next, { authUrl: chosen.authUrl, tokenUrl: chosen.tokenUrl, scope: chosen.scope, authentication: chosen.authentication ?? "body" });
      }
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const data: Record<string, string | boolean | null> = {};
      for (const field of spec?.fields ?? []) {
        if (field.managed) continue;
        const value = values[field.name];
        if (field.secret && (value === true || value === undefined)) continue;
        if (value !== undefined) data[field.name] = value;
      }
      if (type === "oAuth2Api" && !values.preset) {
        data.preset = "google";
        Object.assign(data, { authUrl: data.authUrl ?? oauthPreset("google")?.authUrl, tokenUrl: data.tokenUrl ?? oauthPreset("google")?.tokenUrl, scope: data.scope ?? oauthPreset("google")?.scope });
      }
      const { credential } = await workflowsApi.saveCredential({ id: initial?.id, name: name.trim() || spec?.label || "Credential", type, data });
      onSaved(credential);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      aria-label={initial ? t("Edit credential {name}", { name: initial.name }) : t("New credential")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {!initial && recipes.length ? (
        <Field label={t("Service setup")} hint={t("Choose a service for the right authentication defaults, or configure a generic credential below.")}>
          <Select value={recipeId} onChange={(event) => {
            const chosen = credentialRecipe(event.target.value);
            setRecipeId(event.target.value);
            setError(null);
            if (chosen) {
              setType(chosen.type);
              setName(chosen.label);
              setValues(recipeValues(chosen));
            } else {
              setValues(credentialDefaults(type));
            }
          }}>
            <option value="">{t("Custom credential")}</option>
            {recipes.map((entry) => <option key={entry.id} value={entry.id}>{t(entry.label)}</option>)}
          </Select>
        </Field>
      ) : null}
      {recipe ? <Notice>{t(recipe.instructions)}{" "}<a className="underline" href={recipe.docsUrl} target="_blank" rel="noreferrer noopener">{t("Setup guide")}</a></Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("Type")}>
          <Select value={type} disabled={Boolean(initial)} onChange={(event) => {
            setType(event.target.value);
            setRecipeId("");
            setValues(credentialDefaults(event.target.value));
            setError(null);
          }}>
            {types.map((entry) => (
              <option key={entry.type} value={entry.type}>
                {t(entry.label)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Name")}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder={spec?.label} maxLength={80} />
        </Field>
      </div>
      {spec ? <p className="text-[13px] text-muted">{t(spec.description)}</p> : null}
      {type === "oAuth2Api" ? (
        <Notice>
          {t("Register an app with the provider")}{preset?.consoleUrl ? (
            <>
              {" "}(<a className="underline" href={preset.consoleUrl} target="_blank" rel="noreferrer noopener">{new URL(preset.consoleUrl).host}</a>)
            </>
          ) : null}
          {t(", add this redirect URI to it, then paste its client ID and secret:")}{" "} <code className="font-mono break-all">{redirectUri()}</code>
        </Notice>
      ) : null}
      {(spec?.fields ?? [])
        .filter((field) => !field.managed)
        .map((field) => {
          const value = values[field.name];
          if (field.type === "boolean") {
            return (
              <label key={field.name} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={value === true || value === "true"} onChange={(event) => setField(field.name, event.target.checked)} />
                {t(field.label)}
              </label>
            );
          }
          const hint = field.secret && secretSet(field) ? "Saved. Leave empty to keep it, type to replace it." : field.description;
          return (
            <Field key={field.name} label={`${t(field.label)}${field.required ? " *" : ""}`} hint={hint}>
              {field.type === "options" ? (
                <Select value={String(value ?? field.default ?? "")} onChange={(event) => setField(field.name, event.target.value)}>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {t(option.label)}
                    </option>
                  ))}
                </Select>
              ) : field.type === "text" ? (
                <TextArea rows={4} value={value === true ? "" : String(value ?? "")} placeholder={field.secret && secretSet(field) ? t("•••••• (saved)") : field.placeholder} onChange={(event) => setField(field.name, event.target.value)} autoComplete="off" />
              ) : (
                <TextInput
                  type={field.type === "password" ? "password" : "text"}
                  value={value === true ? "" : String(value ?? field.default ?? "")}
                  placeholder={field.secret && secretSet(field) ? t("•••••• (saved)") : field.placeholder}
                  onChange={(event) => setField(field.name, event.target.value)}
                  autoComplete={field.type === "password" ? "new-password" : "off"}
                />
              )}
            </Field>
          );
        })}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("Saving…") : t("Save credential")}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t("Cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** Opens the provider in a popup; resolves when the callback page reports back (or the popup closes). */
export function connectOAuth(credentialId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const popup = window.open(`/api/workflows/oauth/start?credential=${encodeURIComponent(credentialId)}`, "knife-oauth", "width=560,height=720");
    if (!popup) {
      window.open(`/api/workflows/oauth/start?credential=${encodeURIComponent(credentialId)}`, "_self");
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || (event.data as { type?: string })?.type !== "knife-oauth") return;
      done(Boolean((event.data as { ok?: boolean }).ok));
    };
    const timer = window.setInterval(() => popup.closed && done(false), 700);
    function done(ok: boolean) {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      resolve(ok);
    }
    window.addEventListener("message", onMessage);
  });
}

/** The credentials tab on its own (old bookmarks: `?tab=credentials`); the Workflows page opens the same manager in a drawer. */
export default function CredentialsTab() {
  const { t } = useT();
  return (
    <div className="space-y-4">
      <Panel title={t("Credentials")} right={<ButtonLink href="/tools/workflows" size="sm">{t("← Workflows")}</ButtonLink>}>
        <CredentialsManager />
      </Panel>
    </div>
  );
}

/** List, add, edit, connect (OAuth2) and delete the account's workflow credentials. `onChange` after every change. */
export function CredentialsManager({ onChange }: { onChange?: () => void }) {
  const { t } = useT();
  const [credentials, setCredentials] = useState<PublicCredential[] | null>(null);
  const [editing, setEditing] = useState<PublicCredential | "new" | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "error" | "info"; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setCredentials((await workflowsApi.credentials()).credentials);
      onChange?.();
    } catch (caught) {
      setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
      setCredentials([]);
    }
  }, [onChange]);
  useEffect(() => {
    let alive = true;
    workflowsApi.credentials().then(
      (result) => alive && setCredentials(result.credentials),
      (caught: unknown) => {
        if (!alive) return;
        setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
        setCredentials([]);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div data-credentials-manager>
      {editing ? null : (
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            {t("New credential")}
          </Button>
        </div>
      )}
      <p className="mb-4 text-[13px] text-muted">
        {t("Keys, tokens and logins your workflow nodes use (HTTP Request, Webhook auth, JWT, TOTP…). They are sealed in your account and never shown again after saving; a run hands each node only the credential it names.")}
      </p>
      {message ? (
        <div className="mb-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      ) : null}
      {editing ? (
        <CredentialForm
          initial={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={(credential) => {
            setEditing(null);
            setMessage({ tone: "good", text: `Saved "${credential.name}".${credential.connected === false ? t(" Press Connect to sign in with the provider.") : ""}` });
            void load();
          }}
        />
      ) : credentials === null ? (
        <p role="status" className="text-sm text-muted">{t("Loading credentials…")}</p>
      ) : credentials.length === 0 ? (
        <EmptyState title={t("No credentials yet")} action={<Button variant="primary" onClick={() => setEditing("new")}>{t("New credential")}</Button>}>
          {t("Add an API key, a bearer token, a login or an OAuth2 app (Google, Meta, Microsoft…) for your workflows.")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label={t("Credentials")}>
          {credentials.map((credential) => (
            <li key={credential.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{credential.name}</p>
                <p className="text-xs text-muted">
                  {t("{value} · updated {value2}", { value: credentialType(credential.type)?.label ?? credential.type, value2: new Date(credential.updatedAt).toLocaleString("en-GB") })}
                </p>
              </div>
              {credential.connected !== undefined ? <Badge tone={credential.connected ? "good" : "warn"}>{credential.connected ? t("Connected") : t("Not connected")}</Badge> : null}
              {credential.type === "oAuth2Api" ? (
                <Button
                  size="sm"
                  onClick={async () => {
                    const ok = await connectOAuth(credential.id);
                    setMessage(ok ? { tone: "good", text: `"${credential.name}" is connected.` } : { tone: "info", text: t("The sign-in window closed before connecting.") });
                    void load();
                  }}
                >
                  {credential.connected ? t("Reconnect") : t("Connect")}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setEditing(credential)}>
                {t("Edit")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (!window.confirm(t("Delete the credential \"{name}\"? Nodes using it will fail until you choose another.", { name: credential.name }))) return;
                  try {
                    const { usedBy } = await workflowsApi.deleteCredential(credential.id);
                    setMessage({ tone: usedBy.length ? "info" : "good", text: usedBy.length ? t("Deleted. It was used by: {nodes}.", { nodes: usedBy.join(", ") }) : t("Deleted.") });
                  } catch (caught) {
                    setMessage({ tone: "error", text: caught instanceof Error ? caught.message : String(caught) });
                  }
                  void load();
                }}
              >
                {t("Delete")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
