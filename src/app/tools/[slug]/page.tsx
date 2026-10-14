import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ToolShell } from "@/components/ToolShell";
import { TOOLS, findTool, resolveAlias, toolHref } from "@/lib/registry";
import { ToolView } from "@/tools/registry-client";

export function generateStaticParams() {
  return TOOLS.map((tool) => ({ slug: tool.slug }));
}

export async function generateMetadata({
  params,
}: PageProps<"/tools/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const tool = findTool(slug);
  if (!tool) return {};
  return { title: tool.name, description: tool.tagline };
}

export default async function ToolPage({ params }: PageProps<"/tools/[slug]">) {
  const { slug } = await params;
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
