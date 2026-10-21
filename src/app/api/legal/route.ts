import { NextResponse } from "next/server";
import { LEGAL_DOCS, legalPage, legalVersion, pickLang, type LegalDoc } from "@/lib/legal/legal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/legal -> { version } : the legal version a sign-up must accept (src/lib/legal/legal.ts).
 * GET /api/legal?doc=terms|privacy&lang=pl|en -> the page as a Markdown download (a form the person can save and print,
 * UŚUDE art. 8). Public in both modes: the texts must be readable before an account exists.
 */
export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const doc = params.get("doc");
  if (!doc) return NextResponse.json({ version: legalVersion() }, { headers: { "Cache-Control": "no-store" } });
  if (!(LEGAL_DOCS as readonly string[]).includes(doc)) return NextResponse.json({ error: "unknown doc" }, { status: 404 });
  const page = legalPage(doc as LegalDoc, pickLang(params.get("lang"), request.headers.get("accept-language")));
  return new NextResponse(page.markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${page.doc}-${page.lang}-${page.version}.md"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
