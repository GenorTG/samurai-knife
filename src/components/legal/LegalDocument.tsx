import Link from "next/link";
import { headers } from "next/headers";
import { Notice } from "@/components/ui";
import { legalPage, pickLang, type LegalDoc } from "@/lib/legal/legal";

const PROSE = [
  "space-y-3 text-sm leading-relaxed text-ink",
  "[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h2]:pt-4 [&_h2]:text-lg [&_h2]:font-semibold",
  "[&_h3]:pt-2 [&_h3]:text-base [&_h3]:font-semibold",
  "[&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5",
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_td]:border [&_td]:border-line [&_td]:p-2 [&_td]:align-top",
  "[&_th]:border [&_th]:border-line [&_th]:bg-raised [&_th]:p-2 [&_th]:align-top",
  "[&_code]:rounded [&_code]:bg-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px]",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted",
].join(" ");

const LABELS = {
  pl: { terms: "Regulamin", privacy: "Polityka prywatności", version: "Wersja", effective: "obowiązuje od", download: "Pobierz (Markdown)", other: "English", incomplete: "Operator tej instancji nie uzupełnił jeszcze wszystkich danych w tym dokumencie." },
  en: { terms: "Terms of Service", privacy: "Privacy notice", version: "Version", effective: "effective from", download: "Download (Markdown)", other: "Polski", incomplete: "The operator of this instance has not filled in every detail of this document yet." },
} as const;

/** A legal page (src/lib/legal/legal.ts): Polish for a Polish browser, else English; ?lang= switches. Public. */
export async function LegalDocument({ doc, lang: requested }: { doc: LegalDoc; lang: string | undefined }) {
  const lang = pickLang(requested, (await headers()).get("accept-language"));
  const page = legalPage(doc, lang);
  const t = LABELS[lang];
  const other = lang === "pl" ? "en" : "pl";
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10" lang={lang}>
      <article className="mx-auto w-full max-w-3xl space-y-4">
        <nav aria-label={lang === "pl" ? "Dokumenty" : "Documents"} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <Link href={`/terms?lang=${lang}`} aria-current={doc === "terms" ? "page" : undefined} className={doc === "terms" ? "font-semibold text-ink" : "hover:text-ink"}>{t.terms}</Link>
          <Link href={`/privacy?lang=${lang}`} aria-current={doc === "privacy" ? "page" : undefined} className={doc === "privacy" ? "font-semibold text-ink" : "hover:text-ink"}>{t.privacy}</Link>
          <span className="ml-auto flex gap-4">
            <Link href={`/${doc}?lang=${other}`} hrefLang={other} className="hover:text-ink">{t.other}</Link>
            <a href={`/api/legal?doc=${doc}&lang=${lang}`} className="hover:text-ink">{t.download}</a>
          </span>
        </nav>
        {page.missing.length > 0 ? <Notice tone="warn">{t.incomplete}</Notice> : null}
        <div className={PROSE} dangerouslySetInnerHTML={{ __html: page.html }} />
        <p className="border-t border-line pt-4 font-mono text-xs text-faint">
          {t.version} {page.version}
          {page.effectiveDate ? ` · ${t.effective} ${page.effectiveDate}` : null}
        </p>
      </article>
    </main>
  );
}
