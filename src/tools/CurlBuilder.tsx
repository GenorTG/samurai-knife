"use client";
import { useMemo, useState } from "react";
import { CopyButton, Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import { buildCurlCommand } from "@/lib/curl-command";
export default function CurlBuilder() {
  const [method, setMethod] = useState("GET"), [url, setUrl] = useState("https://api.example.com/items?limit=10"), [headers, setHeaders] = useState("Accept: application/json\nAuthorization: Bearer YOUR_TOKEN"), [body, setBody] = useState("");
  const { command, bodyDropped } = useMemo(() => buildCurlCommand({ method, url, headers, body }), [body, headers, method, url]);
  return <Panel title="cURL command builder" right={<CopyButton text={command} label="Copy command" />}><div className="space-y-3"><div className="grid gap-3 sm:grid-cols-[10rem_1fr]"><Field label="Method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((v) => <option key={v}>{v}</option>)}</Select></Field><Field label="URL"><TextInput value={url} onChange={(e) => setUrl(e.target.value)} /></Field></div>
    <Field label="Headers (one per line)"><TextArea rows={5} value={headers} onChange={(e) => setHeaders(e.target.value)} /></Field><Field label="Request body (optional)"><TextArea rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></Field>{bodyDropped ? <Notice>HEAD requests carry no body, so the request body is left out (curl would turn a HEAD with --data-raw into a POST). Pick another method to send it.</Notice> : null}<Field label="Generated shell command"><TextArea rows={6} readOnly value={command} /></Field>
    <p className="text-xs text-faint">POSIX shell quoting is applied (--data-raw, so a body starting with @ is never read as a file; HEAD uses --head and never sends a body). Review the URL and credentials before running; the command is generated locally and never executed here.</p></div></Panel>;
}
