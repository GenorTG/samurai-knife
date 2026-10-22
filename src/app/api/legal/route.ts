import { NextResponse } from "next/server";
import { LEGAL_DOCS, legalHistory, legalPage, legalVersion, pickLang, type LegalDoc } from "@/lib/legal/legal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/legal -> { version, edition, history } : the legal version a sign-up must accept and the versions this
 * instance has shown (src/lib/legal/legal.ts).
 * GET /api/legal?doc=terms|privacy&lang=pl|en[&version=|&edition=] -> the page as a Markdown download (a form the person
 * can save and print, UŚUDE art. 8), the current one or an earlier one. Public in both modes: the texts must be readable
 * before an account exists.
 */
export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const doc = params.get("doc");
  if (!doc) {
    const version = legalVersion();
    const edition = legalPage("terms", "en").edition;
    return NextResponse.json({ version, edition, history: legalHistory() }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!(LEGAL_DOCS as readonly string[]).includes(doc)) return NextResponse.json({ error: "unknown doc" }, { status: 404 });
  const edition = params.get("edition");
  const page = legalPage(doc as LegalDoc, pickLang(params.get("lang"), request.headers.get("accept-language")), process.env, {
    version: params.get("version")?.slice(0, 64) || undefined,
    edition: edition && /^\d{1,4}$/.test(edition) ? Number(edition) : undefined,
  });
  return new NextResponse(page.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${page.doc}-${page.lang}-${page.version.replace(/[^A-Za-z0-9._-]/g, "_")}.md"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
