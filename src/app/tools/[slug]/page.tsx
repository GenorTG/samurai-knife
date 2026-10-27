import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ToolShell } from "@/components/ToolShell";
import { findTool, resolveAlias, toolHref } from "@/lib/registry";
import { ToolView } from "@/tools/registry-client";
import { queryString, requireSignIn } from "@/lib/accounts/viewer";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata({
  params,
}: PageProps<"/tools/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const tool = findTool(slug);
  if (!tool) return {};
  const { t } = await getT();
  return { title: t(tool.name), description: t(tool.tagline) };
}

// Public mode decides per request whether the visitor may see a tool at all; a prerendered page would skip the gate.
export const dynamic = "force-dynamic";

/** Retired suites whose old tabs are steps inside the new tab (the tab shows `?step=`). */
const RETIRED_STEPS: Record<string, true> = { "site-studio": true };

export default async function ToolPage({ params, searchParams }: PageProps<"/tools/[slug]">) {
  const { slug } = await params;
  // Every tool needs a session in public mode (guests see the welcome page); the login round trip keeps ?tab= and friends.
  await requireSignIn(`/tools/${encodeURIComponent(slug)}${queryString(await searchParams)}`);
  // Retired slugs (tools folded into a suite) are permanent bookmarks: send
  // them to the suite, on the tab that used to be the standalone tool.
  if (resolveAlias(slug)) {
    const tab = (await searchParams).tab;
    const target = toolHref(slug, typeof tab === "string" ? tab : null);
    // A retired suite whose tabs became steps of one tab (site-studio -> cv-studio Website) keeps the old tab as `step`.
    const step = typeof tab === "string" && /^[a-z-]{1,20}$/.test(tab) && !target.includes(`tab=${tab}`) && RETIRED_STEPS[slug] ? tab : null;
    permanentRedirect(step ? `${target}&step=${step}` : target);
  }
  const tool = findTool(slug);
  if (!tool) notFound();

  return (
    <ToolShell tool={tool}>
      <ToolView slug={slug} />
    </ToolShell>
  );
}
