"use client";
import { useState } from "react";
import { Field, Notice, Panel, TextArea, WorkStatus } from "@/components/ui";
import { DIAGRAM_INLINE_LIMIT, diagramJson } from "@/lib/json-diagram";
import { diagramJsonInWorker } from "@/lib/json-diagram-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";
const SAMPLE=`{"user":{"id":42,"name":"Ada","roles":["admin","editor"]},"active":true}`;
export default function JsonDiagram(){const [input,setInput]=useState(SAMPLE);const job=useAdaptive(diagramJson,diagramJsonInWorker,input,input.length<=DIAGRAM_INLINE_LIMIT);const stale=job.status==="cancelled"||job.status==="error";const pending=job.status!=="done"&&!stale;const result=stale||pending?null:job.value;
 return <Panel title="JSON structure diagrammer"><div className="space-y-3"><Field label="JSON document"><TextArea rows={9} spellCheck={false} value={input} onChange={(e)=>setInput(e.target.value)} /></Field><WorkStatus running={job.status==="running"} elapsedMs={job.elapsedMs} label="Reading the structure" cancelLabel="Cancel diagram" onCancel={job.cancel} />{job.status==="cancelled"?<Notice>Diagram cancelled. Edit the document to build it again.</Notice>:null}{job.status==="error"?<Notice tone="error">{job.error}</Notice>:null}{pending?<Notice>Reading the structure…</Notice>:result?.error?<Notice tone="error">{result.error}</Notice>:result?<div className="max-h-[32rem] overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs">{result.rows.map((row,index)=><div key={index} className="grid grid-cols-[minmax(0,1fr)_9rem] gap-3 border-b border-line/50 py-1" style={{paddingLeft:row.depth*14}} title={row.path}><span className="truncate">{row.depth?"↳ ":""}{row.label}</span><span className="text-faint">{row.type}</span></div>)}</div>:null}<p className="text-xs text-faint">Tree is bounded to depth 10, 50 children per node, and 1,000 displayed nodes. Paths use JSON-Pointer-style escaping.</p></div></Panel>;
}
