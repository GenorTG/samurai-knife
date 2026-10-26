"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { formatSql } from "@/lib/sql/instant-format";
import { useStoredDialect } from "@/lib/sql/schema-store";
import { DialectSelect } from "@/tools/db/sql-shared";
import { useT } from "@/lib/i18n/react";
type Mode = "instant" | "server";

export default function SqlFormatter() {
  const { t } = useT();
  const [input, setInput] = useState("select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.active = true group by u.id, u.name order by orders desc limit 20;");
  const [upper, setUpper] = useState(true);
  const [mode, setMode] = useState<Mode>("instant");
  const [dialect, setDialect] = useStoredDialect("postgres");
  const [serverOutput, setServerOutput] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ticket = useRef(0);
  const instant = useMemo(() => formatSql(input, upper), [input, upper]);

  const runServer = async () => {
    const mine = (ticket.current += 1);
    if (!input.trim()) {
      setServerOutput("");
      setServerError(null);
      setBusy(false); // a request still in flight is discarded below: nothing else would clear the flag
      return;
    }
    setBusy(true);
    const response = await callSql("format", { sql: input, dialect });
    if (mine !== ticket.current) return;
    setBusy(false);
    if (response.ok) {
      setServerOutput(response.data.sql);
      setServerError(null);
    } else {
      setServerOutput("");
      setServerError(response.error);
    }
  };

  useEffect(() => {
    if (mode !== "server") return;
    const timer = setTimeout(() => void runServer(), 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, input, dialect]);

  const output = mode === "server" ? serverOutput : instant;
  return <Panel title={t("SQL formatter")} right={<div className="flex gap-1.5"><CopyButton text={output} label={t("Copy formatted SQL")} /><Button size="sm" disabled={!output} onClick={() => downloadText(output.endsWith("\n") ? output : `${output}\n`, "formatted.sql", "application/sql")}>{t("Download .sql")}</Button></div>}><div className="space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <Field label={t("Formatter")} className="w-64 max-w-full"><Select aria-label={t("Formatter")} value={mode} onChange={(e) => setMode(e.target.value as Mode)}><option value="instant">{t("Instant (browser, lightweight)")}</option><option value="server">{t("Dialect-aware (server)")}</option></Select></Field>
      {mode === "server" ? <Field label={t("Dialect")} className="w-64 max-w-full"><DialectSelect label={t("Dialect")} value={dialect} onChange={setDialect} /></Field> : <Field label={t("Keyword casing")} className="w-52 max-w-full"><Select value={upper ? "upper" : "lower"} onChange={(e) => setUpper(e.target.value === "upper")}><option value="upper">{t("Uppercase")}</option><option value="lower">{t("Lowercase")}</option></Select></Field>}
    </div>
    <div className="grid gap-3 lg:grid-cols-2"><Field label={t("SQL input")}><TextArea rows={14} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field><Field label={t("Formatted output")}><TextArea rows={14} readOnly value={mode === "server" && busy && !serverOutput ? "Formatting…" : output} /></Field></div>
    {serverError && mode === "server" ? <div role="alert"><Notice tone="error">{serverError}</Notice></div> : null}
    <p className="text-xs text-faint">{mode === "server" ? t("Parsed and re-printed by a real SQL parser in the chosen dialect; invalid SQL is reported as an error instead of being passed through. Never executed.") : t("A lightweight layout helper for common clauses and lists, not a dialect-aware SQL parser. Review output before running it.")}</p>
  </div></Panel>;
}
