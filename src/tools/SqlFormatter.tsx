"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, Select, TextArea } from "@/components/ui";
import { downloadText } from "@/lib/format";
import { callSql } from "@/lib/sql/client";
import { formatSql } from "@/lib/sql/instant-format";
import { useStoredDialect } from "@/lib/sql/schema-store";
import { DialectSelect } from "@/tools/db/sql-shared";
type Mode = "instant" | "server";

export default function SqlFormatter() {
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
  return <Panel title="SQL formatter" right={<div className="flex gap-1.5"><CopyButton text={output} label="Copy formatted SQL" /><Button size="sm" disabled={!output} onClick={() => downloadText(output.endsWith("\n") ? output : `${output}\n`, "formatted.sql", "application/sql")}>Download .sql</Button></div>}><div className="space-y-3">
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Formatter" className="w-64 max-w-full"><Select aria-label="Formatter" value={mode} onChange={(e) => setMode(e.target.value as Mode)}><option value="instant">Instant (browser, lightweight)</option><option value="server">Dialect-aware (server)</option></Select></Field>
      {mode === "server" ? <Field label="Dialect" className="w-64 max-w-full"><DialectSelect label="Dialect" value={dialect} onChange={setDialect} /></Field> : <Field label="Keyword casing" className="w-52 max-w-full"><Select value={upper ? "upper" : "lower"} onChange={(e) => setUpper(e.target.value === "upper")}><option value="upper">Uppercase</option><option value="lower">Lowercase</option></Select></Field>}
    </div>
    <div className="grid gap-3 lg:grid-cols-2"><Field label="SQL input"><TextArea rows={14} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} /></Field><Field label="Formatted output"><TextArea rows={14} readOnly value={mode === "server" && busy && !serverOutput ? "Formatting…" : output} /></Field></div>
    {serverError && mode === "server" ? <div role="alert"><Notice tone="error">{serverError}</Notice></div> : null}
    <p className="text-xs text-faint">{mode === "server" ? "Parsed and re-printed by a real SQL parser in the chosen dialect; invalid SQL is reported as an error instead of being passed through. Never executed." : "A lightweight layout helper for common clauses and lists, not a dialect-aware SQL parser. Review output before running it."}</p>
  </div></Panel>;
}
