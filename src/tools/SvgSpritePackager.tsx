"use client";
import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";
import { sanitizeSvgMarkup } from "@/lib/svg";
const SAMPLE=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18M12 3v18" stroke="currentColor" stroke-width="2"/></svg>`;
const toId=(name:string)=>name.toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"")||"icon";
export default function SvgSpritePackager(){
 const [name,setName]=useState("add"),[source,setSource]=useState(SAMPLE),[sprite,setSprite]=useState(""),[error,setError]=useState("");
 const build=()=>{try{const clean=sanitizeSvgMarkup(source),doc=new DOMParser().parseFromString(clean,"image/svg+xml"),root=doc.documentElement,viewBox=root.getAttribute("viewBox");if(!viewBox)throw new Error("Each SVG needs an explicit viewBox.");const id=toId(name);const children=[...root.childNodes].map((node)=>new XMLSerializer().serializeToString(node)).join("");setSprite(`<svg xmlns="http://www.w3.org/2000/svg"><symbol id="${id}" viewBox="${viewBox}">${children}</symbol></svg>`);setError("");}catch(e){setSprite("");setError(e instanceof Error?e.message:"Could not package SVG.");}};
 const id=toId(name);
 return <Panel title="SVG symbol-sprite packager" right={<CopyButton text={sprite} label="Copy sprite" />}><div className="space-y-3"><Field label="Symbol name"><TextInput value={name} onChange={(e)=>setName(e.target.value)} /></Field><Field label="SVG icon markup"><TextArea rows={10} value={source} onChange={(e)=>setSource(e.target.value)} /></Field><Button variant="primary" onClick={build}>Build safe symbol</Button>{error&&<Notice tone="error">{error}</Notice>}{sprite&&<><Field label="Sprite SVG"><TextArea rows={6} readOnly value={sprite} /></Field><Field label="Reference example"><TextArea rows={2} readOnly value={`<svg aria-hidden="true"><use href="icons.svg#${id}" /></svg>`} /></Field></>}<p className="text-xs text-faint">Builds one symbol from a sanitized SVG. Combine symbols under a shared root to create a multi-icon sprite.</p></div></Panel>;
}
