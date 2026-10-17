import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ToolShell } from "@/components/ToolShell";
import { findTool, resolveAlias, toolHref } from "@/lib/registry";
import { ToolView } from "@/tools/registry-client";
import { queryString, requireSignIn } from "@/lib/accounts/viewer";

export async function generateMetadata({
  params,
}: PageProps<"/tools/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const tool = findTool(slug);
  if (!tool) return {};
  return { title: tool.name, description: tool.tagline };
}

// Public mode decides per request whether the visitor may see a tool at all; a prerendered page would skip the gate.
export const dynamic = "force-dynamic";

export default async function ToolPage({ params, searchParams }: PageProps<"/tools/[slug]">) {
  const { slug } = await params;
  // Every tool needs a session in public mode (guests see the welcome page); the login round trip keeps ?tab= and friends.
  await requireSignIn(`/tools/${encodeURIComponent(slug)}${queryString(await searchParams)}`);
  // Retired slugs (tools folded into a suite) are permanent bookmarks: send
  // them to the suite, on the tab that used to be the standalone tool.
  if (resolveAlias(slug)) permanentRedirect(toolHref(slug));
  const tool = findTool(slug);
  if (!tool) notFound();

  return (
    <ToolShell tool={tool}>
      <ToolView slug={slug} />
    </ToolShell>
  );
}
