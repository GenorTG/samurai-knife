"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Field, KeyValues, Notice, Panel, Select, TextInput } from "@/components/ui";
import {
  buildDsn,
  DSN_KINDS,
  emptyFields,
  kindInfo,
  parseDsn,
  PASSWORD_MASK,
  validateFields,
  type DsnFields,
  type DsnKind,
} from "@/lib/sql/dsn";
import { buildSnippets, shellQuote } from "./dsn-snippets";
import { useT } from "@/lib/i18n/react";

/**
 * Connection-string builder/parser. Purely string manipulation: no connection is ever opened, and the password
 * lives only in this component's state (never localStorage, never the page URL).
 */
export default function DbConnect() {
  const { t } = useT();
  const [fields, setFields] = useState<DsnFields>(() => ({
    ...emptyFields("postgres"),
    host: "db.internal",
    user: "app",
    database: "shop",
  }));
  const [reveal, setReveal] = useState(false);
  const [pasted, setPasted] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseNotes, setParseNotes] = useState<string[]>([]);
  const [envName, setEnvName] = useState<string | null>(null);

  const info = kindInfo(fields.kind);
  const problems = useMemo(() => validateFields(fields), [fields]);
  const maskedUrl = useMemo(() => buildDsn(fields, true), [fields]);
  const realUrl = useMemo(() => buildDsn(fields, false), [fields]);
  const shownUrl = reveal ? realUrl : maskedUrl;
  const hasSecret = info.hasAuth && fields.password.length > 0;
  const envVar = envName ?? info.envVar;
  const envLine = `${envVar}=${shellQuote(shownUrl)}`;
  const snippets = useMemo(() => buildSnippets(fields, shownUrl, reveal), [fields, shownUrl, reveal]);
  const set = <K extends keyof DsnFields>(key: K, value: DsnFields[K]) => setFields((current) => ({ ...current, [key]: value }));

  const changeKind = (next: DsnKind) => {
    setFields((current) => {
      const old = kindInfo(current.kind);
      const target = kindInfo(next);
      const portIsDefault = current.port === "" || current.port === old.defaultPort;
      return {
        ...current,
        kind: next,
        port: portIsDefault ? target.defaultPort : current.port,
        database: old.file !== target.file ? "" : current.database,
        user: target.hasAuth ? current.user : "",
        password: target.hasAuth ? current.password : "",
      };
    });
    setEnvName(null);
  };

  const parse = () => {
    const result = parseDsn(pasted);
    if (!result.ok) {
      setParseError(result.error);
      setParseNotes([]);
      return;
    }
    setParseError(null);
    setParseNotes(result.notes);
    setFields(result.fields);
    setEnvName(null);
  };

  const field = (name: "host" | "port" | "database") => problems.find((p) => p.field === name);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <Panel title={t("Connection fields")} right={<span className="text-xs text-faint">{t("Nothing connects; strings only")}</span>}>
          <div className="space-y-3">
            <Field label={t("Database type")}>
              <Select value={fields.kind} onChange={(e) => changeKind(e.target.value as DsnKind)}>
                {DSN_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{t(k.label)}</option>
                ))}
              </Select>
            </Field>
            {info.file ? (
              <Field label={info.databaseLabel} hint={t("Relative (./data/app.db), absolute (/var/db/app.db) or :memory:")}>
                <TextInput value={fields.database} onChange={(e) => set("database", e.target.value)} placeholder={t("./data/app.db")} spellCheck={false} />
              </Field>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                  <Field label={info.multiHost ? t("Host (or comma-separated host:port list)") : t("Host")} hint={field("host")?.message}>
                    <TextInput value={fields.host} onChange={(e) => set("host", e.target.value)} placeholder={t("db.internal")} spellCheck={false} autoComplete="off" />
                  </Field>
                  {info.noPort || info.multiHost ? null : (
                    <Field label={t("Port")} hint={field("port")?.message}>
                      <TextInput value={fields.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" placeholder={info.defaultPort} />
                    </Field>
                  )}
                </div>
                {info.hasAuth ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("User")}>
                      <TextInput value={fields.user} onChange={(e) => set("user", e.target.value)} autoComplete="off" spellCheck={false} />
                    </Field>
                    <Field label={t("Password")} hint={t("Kept in this tab only. Never saved or put in the page URL.")}>
                      <TextInput
                        type={reveal ? "text" : "password"}
                        value={fields.password}
                        onChange={(e) => set("password", e.target.value)}
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                    </Field>
                  </div>
                ) : null}
                <Field label={info.databaseLabel} hint={field("database")?.message}>
                  <TextInput value={fields.database} onChange={(e) => set("database", e.target.value)} spellCheck={false} autoComplete="off" />
                </Field>
              </>
            )}
            <Field label={t("Query parameters")} hint={t("Written exactly as typed, e.g. sslmode=require&connect_timeout=10")}>
              <TextInput value={fields.params} onChange={(e) => set("params", e.target.value)} spellCheck={false} placeholder={t("key=value&key2=value2")} />
            </Field>
            {info.hasAuth ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} className="size-4 accent-[var(--c-accent)]" />
                {t("Reveal password in the input and the outputs")}
              </label>
            ) : null}
          </div>
        </Panel>

        <Panel title={t("Parse a connection URL into fields")}>
          <div className="space-y-3">
            <Field label={t("Connection URL to parse")} hint={t("Example: {example}", { example: info.example })}>
              <TextInput value={pasted} onChange={(e) => setPasted(e.target.value)} spellCheck={false} autoComplete="off" placeholder={t("postgresql://user:pass@host:5432/db")} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={parse} disabled={!pasted.trim()}>{t("Parse URL into fields")}</Button>
              <Button variant="ghost" onClick={() => { setPasted(""); setParseError(null); setParseNotes([]); }} disabled={!pasted}>{t("Clear parse input")}</Button>
            </div>
            {parseError ? <div role="alert"><Notice tone="error">{parseError}</Notice></div> : null}
            {parseNotes.length ? <div role="status"><Notice tone="info">{parseNotes.join(" ")}</Notice></div> : null}
          </div>
        </Panel>
      </div>

      <div className="min-w-0 space-y-4">
        <Panel
          title={t("Connection URL")}
          right={
            <div className="flex flex-wrap gap-1.5">
              <CopyButton text={shownUrl} label={hasSecret && !reveal ? t("Copy URL (password hidden)") : t("Copy URL")} />
              {hasSecret && !reveal ? <CopyButton text={realUrl} label={t("Copy URL with password")} /> : null}
            </div>
          }
        >
          <div className="space-y-3">
            {problems.length ? (
              <div role="alert"><Notice tone="warn">{problems.map((p) => p.message).join(" ")}</Notice></div>
            ) : null}
            <pre
              data-agent-region="connection-url"
              aria-label={t("Connection URL")}
              className="sk-input overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap"
            >{shownUrl}</pre>
            {hasSecret && !reveal ? <p className="text-xs text-faint">{t("Password is masked as {passwordMask}. Tick “Reveal password” to show it.", { passwordMask: PASSWORD_MASK })}</p> : null}
            <KeyValues
              rows={[
                ["Scheme", info.scheme],
                ["Host", fields.host || "—"],
                ["Port", info.noPort || info.multiHost ? "—" : fields.port || `${info.defaultPort || "—"} (default)`],
                ["User", fields.user || "—"],
                ["Password", fields.password ? (reveal ? fields.password : PASSWORD_MASK) : "—"],
                [info.databaseLabel, fields.database || "—"],
              ]}
            />
          </div>
        </Panel>

        <Panel title={t("Environment variable")} right={<CopyButton text={envLine} label={t("Copy env line")} />}>
          <div className="space-y-3">
            <Field label={t("Variable name")}>
              <TextInput value={envVar} onChange={(e) => setEnvName(e.target.value.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase())} spellCheck={false} />
            </Field>
            <pre data-agent-region="env-line" aria-label={t("Environment variable line")} className="sk-input overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap">{envLine}</pre>
          </div>
        </Panel>

        <Panel title={t("Client snippets")}>
          <div className="space-y-4" data-agent-region="client-snippets">
            {snippets.map((snippet) => (
              <div key={snippet.label} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-muted">{t(snippet.label)}</h3>
                  <CopyButton text={snippet.code} label={t("Copy {label}", { label: snippet.label })} />
                </div>
                <pre aria-label={t("{label} snippet", { label: snippet.label })} className="sk-input overflow-auto px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-all">{snippet.code}</pre>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
