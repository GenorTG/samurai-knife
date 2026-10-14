import Link from "next/link";
import { ToolActions } from "@/components/ToolActions";
import type { ToolMeta } from "@/lib/registry";

export function Brand() {
  return (
    <Link href="/" className="group inline-flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/blade.svg" alt="" className="size-5 opacity-90 transition-transform group-hover:-rotate-12" />
      <span className="sk-wordmark font-mono max-sm:group-has-[[data-agent-pill]]/header:sr-only text-[12px] font-bold tracking-[0.2em] uppercase">
        Samurai Knife
      </span>
    </Link>
  );
}

export function KindBadge({ kind }: { kind: ToolMeta["kind"] }) {
  const isClient = kind === "client";
  const isRemote = kind === "remote";
  const isSidecar = kind === "sidecar";
  const title = isClient
    ? "Runs entirely in your browser — nothing is uploaded"
    : isRemote
      ? "Sends prompts and tool inputs to the model endpoint you configure"
      : isSidecar
        ? "Runs in an optional docker service on this server (installed from the page)"
        : "Runs on the server (Python venv)";
  const className = isClient
    ? "rounded-md border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-faint uppercase"
    : "rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-accent-soft uppercase";
  return (
    <span
      title={title}
      className={className}
    >
      {isClient ? "browser" : isRemote ? "api" : isSidecar ? "sidecar" : "server"}
    </span>
  );
}

export function ToolShell({
  tool,
  children,
}: {
  tool: ToolMeta;
  children: React.ReactNode;
}) {
  return (
    // `sk-tool-main` lets a tool widen the shell from CSS (see globals.css),
    // so the shell never needs to know slugs or tab ids.
    <main className="sk-tool-main w-full px-4 py-5 sm:px-6 sm:py-6 xl:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line pb-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{tool.name}</h1>
            <KindBadge kind={tool.kind} />
          </div>
          <p className="mt-1.5 max-w-3xl text-[15px] text-muted">{tool.tagline}</p>
        </div>
        <div className="flex items-center gap-2">
          <ToolActions tool={tool} />
        </div>
      </header>
      {children}
    </main>
  );
}
