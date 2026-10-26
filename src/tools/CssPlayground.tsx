"use client";

/**
 * CSS playground: edit HTML, CSS and JavaScript or TypeScript side by side with a live preview, start from effect
 * presets, see the preview's console, and export the result (one HTML file, or each file). The assistant can write the
 * files too: the code fields are fillable (src/components/CodeEditor.tsx, dom-bridge `data-agent-code`).
 *
 * The preview is an `<iframe sandbox="allow-scripts" srcdoc>`: an opaque origin, so the code cannot reach this page,
 * its cookies or its storage. TypeScript is transpiled in the browser (sucrase, loaded on first use).
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, FullscreenButton, Notice } from "@/components/ui";
import { cx } from "@/lib/format";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const CodeEditor = dynamic(() => import("@/components/CodeEditor"), { ssr: false, loading: () => <div className="h-full animate-pulse rounded-lg bg-raised" /> });

type ScriptLang = "js" | "ts";
type FileId = "html" | "css" | "script";
interface Project {
  html: string;
  css: string;
  script: string;
  lang: ScriptLang;
}
interface LogLine {
  level: "log" | "info" | "warn" | "error";
  text: string;
}

const STORE_KEY = "knife:css-playground:v1";

const PRESETS: { id: string; name: string; project: Project }[] = [
  {
    id: "glass",
    name: msg("Glass card"),
    project: {
      lang: "js",
      html: `<main class="scene">\n  <article class="card">\n    <h1>Glass card</h1>\n    <p>Frosted background, soft border and a gentle shadow.</p>\n    <button>Get started</button>\n  </article>\n</main>`,
      css: `body { margin: 0; font-family: system-ui, sans-serif; }\n.scene {\n  min-height: 100vh; display: grid; place-items: center;\n  background: radial-gradient(circle at 20% 20%, #ff6ec4, transparent 40%),\n              radial-gradient(circle at 80% 30%, #7873f5, transparent 40%),\n              radial-gradient(circle at 50% 90%, #4ade80, transparent 45%), #0f172a;\n}\n.card {\n  width: min(22rem, 90vw); padding: 2rem; border-radius: 1.25rem; color: white;\n  background: rgb(255 255 255 / 0.12);\n  border: 1px solid rgb(255 255 255 / 0.25);\n  backdrop-filter: blur(16px) saturate(140%);\n  box-shadow: 0 20px 50px rgb(0 0 0 / 0.35);\n}\n.card h1 { margin: 0 0 .5rem; font-size: 1.6rem; }\n.card button {\n  margin-top: 1rem; padding: .6rem 1.1rem; border: 0; border-radius: .7rem;\n  background: white; color: #0f172a; font-weight: 600; cursor: pointer;\n}`,
      script: ``,
    },
  },
  {
    id: "gradient-button",
    name: msg("Animated gradient button"),
    project: {
      lang: "js",
      html: `<button class="glow">Hover me</button>`,
      css: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b12; font-family: system-ui, sans-serif; }\n.glow {\n  position: relative; padding: 1rem 2.2rem; border: 0; border-radius: 999px; cursor: pointer;\n  color: white; font-size: 1.1rem; font-weight: 700; letter-spacing: .02em;\n  background: linear-gradient(90deg, #ff0080, #7928ca, #2afadf, #ff0080);\n  background-size: 300% 100%; animation: flow 6s linear infinite;\n  box-shadow: 0 0 0 0 rgb(255 0 128 / .6); transition: box-shadow .3s, transform .3s;\n}\n.glow:hover { transform: translateY(-2px); box-shadow: 0 10px 40px -5px rgb(121 40 202 / .8); }\n@keyframes flow { to { background-position: 300% 0; } }`,
      script: ``,
    },
  },
  {
    id: "neon",
    name: msg("Neon text"),
    project: {
      lang: "js",
      html: `<h1 class="neon">Samurai</h1>`,
      css: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05010a; }\n.neon {\n  font: 800 clamp(3rem, 12vw, 8rem) system-ui, sans-serif; color: #fff;\n  text-shadow: 0 0 6px #fff, 0 0 18px #ff2bd6, 0 0 42px #ff2bd6, 0 0 80px #b300ff;\n  animation: flicker 3s infinite;\n}\n@keyframes flicker { 0%, 18%, 22%, 25%, 53%, 57%, 100% { opacity: 1; } 20%, 24%, 55% { opacity: .55; } }`,
      script: ``,
    },
  },
  {
    id: "loader",
    name: msg("Loading spinner"),
    project: {
      lang: "js",
      html: `<div class="spinner" role="status" aria-label="Loading"></div>`,
      css: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111827; }\n.spinner {\n  width: 64px; aspect-ratio: 1; border-radius: 50%;\n  background: conic-gradient(from 0deg, transparent 0 25%, #38bdf8);\n  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 8px), #000 0);\n          mask: radial-gradient(farthest-side, transparent calc(100% - 8px), #000 0);\n  animation: spin 0.9s linear infinite;\n}\n@keyframes spin { to { transform: rotate(1turn); } }`,
      script: ``,
    },
  },
  {
    id: "tilt",
    name: "3D tilt card (JS)",
    project: {
      lang: "js",
      html: `<div class="stage">\n  <div class="tilt"><span>Move the mouse</span></div>\n</div>`,
      css: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #1e293b, #0f172a); font-family: system-ui, sans-serif; }\n.stage { perspective: 900px; }\n.tilt {\n  width: 18rem; height: 12rem; border-radius: 1rem; display: grid; place-items: center; color: white; font-weight: 700;\n  background: linear-gradient(135deg, #6366f1, #ec4899); box-shadow: 0 30px 60px rgb(0 0 0 / .45);\n  transform-style: preserve-3d; transition: transform .12s ease-out;\n}\n.tilt span { transform: translateZ(40px); }`,
      script: `const card = document.querySelector(".tilt");\ndocument.addEventListener("pointermove", (event) => {\n  const x = event.clientX / innerWidth - 0.5;\n  const y = event.clientY / innerHeight - 0.5;\n  card.style.transform = \`rotateY(\${x * 30}deg) rotateX(\${-y * 30}deg)\`;\n});\nconsole.log("Tilt ready");`,
    },
  },
  {
    id: "typewriter",
    name: msg("Typewriter (TypeScript)"),
    project: {
      lang: "ts",
      html: `<p class="type"><span id="out"></span><span class="caret">|</span></p>`,
      css: `body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #e5e5e5; font: 500 1.6rem ui-monospace, monospace; }\n.caret { animation: blink 1s steps(1) infinite; color: #22d3ee; }\n@keyframes blink { 50% { opacity: 0; } }`,
      script: `const lines: string[] = ["Hello.", "Edit me in the TS tab.", "Export when it looks right."];\nconst out = document.getElementById("out") as HTMLSpanElement;\n\nasync function type(text: string, delay = 60): Promise<void> {\n  for (const ch of text) {\n    out.textContent += ch;\n    await new Promise((r) => setTimeout(r, delay));\n  }\n}\n\n(async () => {\n  for (;;) {\n    for (const line of lines) {\n      out.textContent = "";\n      await type(line);\n      await new Promise((r) => setTimeout(r, 1200));\n    }\n  }\n})();`,
    },
  },
];

const EMPTY: Project = { lang: "js", html: "<h1>Hello</h1>", css: "h1 { font-family: system-ui, sans-serif; color: rebeccapurple; }", script: "" };

function loadProject(): Project {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Project>;
      if (typeof value.html === "string" && typeof value.css === "string" && typeof value.script === "string") return { html: value.html, css: value.css, script: value.script, lang: value.lang === "ts" ? "ts" : "js" };
    }
  } catch {
    // storage blocked or broken: start from the first preset
  }
  return PRESETS[0].project;
}

/** Runs inside the preview: forwards console output and errors to this page (checked by source window). */
const BRIDGE = `<script>(function(){
  var send = function(level, args){ try { parent.postMessage({ knifePlayground: 1, level: level, text: Array.prototype.map.call(args, function(a){ try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(" ") }, "*"); } catch (e) {} };
  ["log","info","warn","error"].forEach(function(level){ var original = console[level]; console[level] = function(){ send(level, arguments); original.apply(console, arguments); }; });
  addEventListener("error", function(e){ send("error", [e.message + (e.lineno ? " (line " + e.lineno + ")" : "")]); });
  addEventListener("unhandledrejection", function(e){ send("error", ["Unhandled promise rejection: " + (e.reason && e.reason.message || e.reason)]); });
})();<\/script>`;

/** `</script` inside user code would end the inline script early. */
function inlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function documentOf(project: Project, js: string, withBridge: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Playground</title>
<style>
${project.css}
</style>
${withBridge ? BRIDGE : ""}
</head>
<body>
${project.html}
${js.trim() ? `<script type="module">\n${inlineScript(js)}\n</script>` : ""}
</body>
</html>
`;
}

async function compile(project: Project): Promise<{ js: string; error?: string }> {
  if (project.lang === "js" || !project.script.trim()) return { js: project.script };
  try {
    const { transform } = await import("sucrase");
    return { js: transform(project.script, { transforms: ["typescript"], disableESTransforms: true }).code };
  } catch (error) {
    return { js: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const BACKGROUNDS = { light: "#ffffff", dark: "#0b0b10", checker: "repeating-conic-gradient(#d4d4d8 0 25%, #f4f4f5 0 50%) 0 0 / 20px 20px" } as const;

export default function CssPlayground() {
  const { t } = useT();
  const [project, setProject] = useState<Project>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [file, setFile] = useState<FileId>("css");
  const [auto, setAuto] = useState(true);
  const [doc, setDoc] = useState("");
  const [compileError, setCompileError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [background, setBackground] = useState<keyof typeof BACKGROUNDS>("light");
  const [note, setNote] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const shell = useRef<HTMLDivElement>(null);

  // Browser storage is read after hydration, so the server and the first client render agree.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from browser storage after hydration
    setProject(loadProject());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(project));
      } catch {
        // storage full or blocked: the session still works
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [project, loaded]);

  const run = useCallback(async () => {
    const result = await compile(project);
    setCompileError(result.error ?? null);
    setLogs([]);
    setDoc(documentOf(project, result.js, true));
  }, [project]);

  useEffect(() => {
    if (!loaded || !auto) return;
    const timer = setTimeout(() => void run(), 350);
    return () => clearTimeout(timer);
  }, [run, auto, loaded]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { knifePlayground?: number; level?: string; text?: string };
      if (data?.knifePlayground !== 1 || typeof data.text !== "string") return;
      const level = (["log", "info", "warn", "error"].includes(data.level ?? "") ? data.level : "log") as LogLine["level"];
      setLogs((current) => [...current.slice(-199), { level, text: data.text!.slice(0, 2000) }]);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const set = (patch: Partial<Project>) => setProject((current) => ({ ...current, ...patch }));
  const scriptName = project.lang === "ts" ? "script.ts" : "script.js";
  const files: { id: FileId; name: string }[] = useMemo(() => [{ id: "html", name: "index.html" }, { id: "css", name: "style.css" }, { id: "script", name: scriptName }], [scriptName]);
  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 2500);
  };

  return (
    <div ref={shell} className="flex h-[calc(100dvh-15rem)] min-h-[600px] flex-col gap-3" data-css-playground>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted">
          {t("Start from")}
          <select
            aria-label={t("Start from a preset")}
            className="sk-input h-8 px-2 text-xs"
            value=""
            onChange={(event) => {
              const preset = PRESETS.find((p) => p.id === event.target.value);
              if (preset && window.confirm(t("Replace the three files with \"{name}\"?", { name: preset.name }))) {
                setProject(preset.project);
                setFile("css");
              }
            }}
          >
            <option value="">{t("Choose an effect…")}</option>
            {PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(preset.name)}
              </option>
            ))}
          </select>
        </label>
        <div role="radiogroup" aria-label={t("Script language")} className="flex rounded-lg border border-line p-0.5 text-xs">
          {(["js", "ts"] as const).map((lang) => (
            <button
              autoComplete="off"
              key={lang}
              type="button"
              role="radio"
              aria-checked={project.lang === lang}
              onClick={() => set({ lang })}
              className={cx("rounded-md px-2.5 py-1", project.lang === lang ? "bg-accent/15 text-ink" : "text-muted hover:text-ink")}
            >
              {lang === "js" ? t("JavaScript") : t("TypeScript")}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          {t("Run as I type")}
        </label>
        {!auto ? (
          <Button size="sm" variant="primary" onClick={() => void run()}>
            {t("Run")}
          </Button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {note ? (
            <span role="status" className="text-xs text-good">
              {note}
            </span>
          ) : null}
          <Button
            size="sm"
            onClick={async () => {
              const result = await compile(project);
              download("playground.html", documentOf(project, result.js, false), "text/html");
            }}
            title={t("One self-contained HTML file with the CSS and the (compiled) script inside")}
          >
            {t("Export HTML")}
          </Button>
          <details className="relative" data-playground-files>
            <summary className="flex h-8 cursor-pointer list-none items-center rounded-lg border border-line px-2.5 text-xs text-muted select-none hover:text-ink [&::-webkit-details-marker]:hidden">{t("Files ▾")}</summary>
            <div role="menu" aria-label={t("Download or copy files")} className="sk-pop absolute top-full right-0 z-20 mt-1 w-44 rounded-lg border border-line-strong bg-surface p-1 shadow-pop">
              {[
                { label: t("Download index.html"), run: () => download("index.html", project.html, "text/html") },
                { label: t("Download style.css"), run: () => download("style.css", project.css, "text/css") },
                ...(project.script.trim() ? [{ label: t("Download {scriptName}", { scriptName }), run: () => download(scriptName, project.script, "text/plain") }] : []),
                {
                  label: t("Copy CSS"),
                  run: async () => {
                    try {
                      await navigator.clipboard.writeText(project.css);
                      flash("CSS copied.");
                    } catch {
                      flash(t("Copy needs https: download style.css instead."));
                    }
                  },
                },
              ].map((item) => (
                <button
                  autoComplete="off"
                  key={item.label}
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    void item.run();
                  }}
                  className="block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs text-ink hover:bg-raised"
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </details>
          <FullscreenButton target={shell} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <section aria-label={t("Files")} className="flex min-h-[320px] flex-col gap-2 lg:min-h-0">
          <div role="tablist" aria-label={t("Files")} className="flex gap-1">
            {files.map((entry) => (
              <button
                autoComplete="off"
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={file === entry.id}
                onClick={() => setFile(entry.id)}
                className={cx("rounded-md px-3 py-1.5 font-mono text-xs", file === entry.id ? "bg-raised text-ink ring-1 ring-line-strong" : "text-muted hover:bg-raised hover:text-ink")}
              >
                {entry.name}
              </button>
            ))}
          </div>
          {/* All three stay mounted (hidden when not shown), so switching files keeps each editor's undo history. */}
          {files.map((entry) => (
            <div key={entry.id} role="tabpanel" aria-label={entry.name} hidden={file !== entry.id} className={cx("min-h-0 flex-1", file === entry.id ? "flex" : "hidden")}>
              <div className="min-h-0 w-full">
                {loaded ? (
                  <CodeEditor
                    fill
                    label={entry.name}
                    language={entry.id === "html" ? "html" : entry.id === "css" ? "css" : project.lang === "ts" ? "typescript" : "javascript"}
                    value={project[entry.id]}
                    onChange={(value) => set({ [entry.id]: value } as Partial<Project>)}
                  />
                ) : null}
              </div>
            </div>
          ))}
        </section>

        <section aria-label={t("Preview")} className="flex min-h-[320px] flex-col gap-2 lg:min-h-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{t("Preview")}</h3>
            <div role="radiogroup" aria-label={t("Preview background")} className="ml-auto flex gap-1 text-[11px]">
              {(Object.keys(BACKGROUNDS) as (keyof typeof BACKGROUNDS)[]).map((key) => (
                <button
                  autoComplete="off"
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={background === key}
                  onClick={() => setBackground(key)}
                  className={cx("rounded px-2 py-0.5 capitalize", background === key ? "bg-raised text-ink ring-1 ring-line-strong" : "text-muted hover:text-ink")}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>
          {compileError ? <Notice tone="error">{t("TypeScript:")}{" "} {compileError}</Notice> : null}
          <iframe
            ref={frame}
            title={t("Preview")}
            sandbox="allow-scripts"
            srcDoc={doc}
            data-page-fill
            className="min-h-0 w-full flex-1 rounded-lg border border-line-strong"
            style={{ background: BACKGROUNDS[background] }}
          />
          <details className="rounded-lg border border-line bg-surface text-xs" open={logs.some((line) => line.level === "error")}>
            <summary className="cursor-pointer px-3 py-1.5 text-muted select-none">
              {t("Console")}{" "} {logs.length ? `(${logs.length})` : ""}
              {logs.some((line) => line.level === "error") ? <span className="ml-2 text-danger">{t("errors")}</span> : null}
            </summary>
            <ol aria-label={t("Console output")} className="max-h-36 overflow-y-auto border-t border-line px-3 py-1.5 font-mono text-[11px]">
              {logs.length ? (
                logs.map((line, index) => (
                  <li key={index} className={cx("break-words whitespace-pre-wrap", line.level === "error" ? "text-danger" : line.level === "warn" ? "text-warn" : "text-muted")}>
                    {line.text}
                  </li>
                ))
              ) : (
                <li className="text-faint">{t("console.log output and errors from the preview show here.")}</li>
              )}
            </ol>
          </details>
        </section>
      </div>
    </div>
  );
}
