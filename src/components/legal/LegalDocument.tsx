import Link from "next/link";
import { headers } from "next/headers";
import { Notice } from "@/components/ui";
import { legalEditions, legalHistory, legalPage, pickLang, recordLegalVersion, termsTransition, type LegalDoc } from "@/lib/legal/legal";

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
  pl: {
    terms: "Regulamin", privacy: "Polityka prywatności", version: "Wersja", edition: "wydanie", effective: "obowiązuje od", published: "opublikowana",
    app: "Smart Knife", download: "Pobierz (Markdown)", other: "English", history: "Wcześniejsze wersje", current: "obecna", read: "czytaj",
    incomplete: "Operator tej instancji nie uzupełnił jeszcze wszystkich danych w tym dokumencie.",
    archived: (when: string) => `To jest wcześniejsza wersja (${when}), zachowana do wglądu. Nie jest już aktualna.`,
    editionNote: "Tekst domyślny tego wydania, uzupełniony obecnymi danymi tej instancji.",
    goCurrent: "Przejdź do obecnej wersji",
    transition: (from: string) => `Dla Kont założonych przed publikacją tej wersji Regulamin w tej wersji obowiązuje od ${from} (§ 15); do tego dnia stosuje się wobec nich poprzednią wersję.`,
    previous: "poprzednia wersja",
    noHistory: "Ta instancja zaczęła zapisywać historię wersji od obecnej wersji. Wcześniejsze wydania tekstów domyślnych:",
  },
  en: {
    terms: "Terms of Service", privacy: "Privacy notice", version: "Version", edition: "edition", effective: "effective from", published: "published",
    app: "Smart Knife", download: "Download (Markdown)", other: "Polski", history: "Earlier versions", current: "current", read: "read",
    incomplete: "The operator of this instance has not filled in every detail of this document yet.",
    archived: (when: string) => `This is an earlier version (${when}), kept for the record. It is no longer current.`,
    editionNote: "The default text of this edition, filled with this instance's current details.",
    goCurrent: "Go to the current version",
    transition: (from: string) => `For Accounts created before this version was published, these Terms apply from ${from} (section 15); until then the previous version applies to them.`,
    previous: "previous version",
    noHistory: "This instance started keeping its version history with the current version. Earlier editions of the default texts:",
  },
} as const;

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "");

/**
 * A legal page (src/lib/legal/legal.ts): Polish for a Polish browser, else English; ?lang= switches; ?version= shows an
 * earlier version from the instance's history, ?edition= an earlier edition of the default texts. Public.
 */
export async function LegalDocument({ doc, lang: requested, version, edition }: { doc: LegalDoc; lang: string | undefined; version?: string; edition?: string }) {
  const lang = pickLang(requested, (await headers()).get("accept-language"));
  // Showing the current version keeps it in the history (what a person reads now stays readable after a change).
  recordLegalVersion();
  const editionNumber = edition && /^\d{1,4}$/.test(edition) ? Number(edition) : undefined;
  const page = legalPage(doc, lang, process.env, { version: version?.slice(0, 64), edition: editionNumber });
  const t = LABELS[lang];
  const other = lang === "pl" ? "en" : "pl";
  const pinned = page.current ? "" : page.source === "edition" ? `&edition=${page.edition}` : `&version=${encodeURIComponent(page.version)}`;
  const history = legalHistory();
  const transition = doc === "terms" && page.current ? termsTransition() : null;
  // Editions of the defaults older than the instance's first kept version stay readable as default text.
  const firstKept = history[0]?.edition ?? page.edition ?? legalEditions()[0]?.edition ?? null;
  const earlierEditions = firstKept === null ? [] : legalEditions().filter((e) => e.edition < firstKept);
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10" lang={lang}>
      <article className="mx-auto w-full max-w-3xl space-y-4">
        <nav aria-label={lang === "pl" ? "Dokumenty" : "Documents"} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <Link href={`/terms?lang=${lang}${pinned}`} aria-current={doc === "terms" ? "page" : undefined} className={doc === "terms" ? "font-semibold text-ink" : "hover:text-ink"}>{t.terms}</Link>
          <Link href={`/privacy?lang=${lang}${pinned}`} aria-current={doc === "privacy" ? "page" : undefined} className={doc === "privacy" ? "font-semibold text-ink" : "hover:text-ink"}>{t.privacy}</Link>
          <span className="ml-auto flex gap-4">
            <Link href={`/${doc}?lang=${other}${pinned}`} hrefLang={other} className="hover:text-ink">{t.other}</Link>
            <a href={`/api/legal?doc=${doc}&lang=${lang}${pinned}`} className="hover:text-ink">{t.download}</a>
          </span>
        </nav>
        {!page.current ? (
          <Notice tone="warn">
            {t.archived(page.source === "edition" ? `${t.edition} ${page.edition}, ${day(page.publishedAt)}` : `${t.version} ${page.version}, ${day(page.publishedAt)}`)}{" "}
            {page.source === "edition" ? `${t.editionNote} ` : null}
            <Link href={`/${doc}?lang=${lang}`} className="underline underline-offset-2">{t.goCurrent}</Link>
          </Notice>
        ) : null}
        {page.current && page.missing.length > 0 ? <Notice tone="warn">{t.incomplete}</Notice> : null}
        {transition ? (
          <Notice>
            {t.transition(transition.existingAccountsFrom)}{" "}
            <Link href={`/terms?lang=${lang}&version=${encodeURIComponent(transition.previous)}`} className="underline underline-offset-2">{t.previous}</Link>
          </Notice>
        ) : null}
        <div className={PROSE} dangerouslySetInnerHTML={{ __html: page.html }} />
        <footer className="space-y-2 border-t border-line pt-4 font-mono text-xs text-faint" data-legal-version={page.version}>
          <p>
            {t.version} {page.version}
            {page.edition !== null ? ` · ${t.edition} ${page.edition}` : null}
            {page.publishedAt ? ` · ${t.published} ${day(page.publishedAt)}` : null}
            {page.effectiveDate ? ` · ${t.effective} ${page.effectiveDate}` : null}
            {page.app ? ` · ${t.app} ${page.app}` : null}
          </p>
          {history.length > 1 || earlierEditions.length > 0 ? (
            <section aria-label={t.history}>
              <h2 className="font-sans text-xs font-semibold text-muted">{t.history}</h2>
              <ul className="mt-1 space-y-0.5">
                {[...history].reverse().map((entry) => (
                  <li key={entry.version}>
                    {entry.version === page.version ? <strong className="text-muted">{entry.version}</strong> : (
                      <Link href={entry.current ? `/${doc}?lang=${lang}` : `/${doc}?lang=${lang}&version=${encodeURIComponent(entry.version)}`} className="underline underline-offset-2 hover:text-ink">{entry.version}</Link>
                    )}
                    {entry.edition !== null ? ` · ${t.edition} ${entry.edition}` : null}
                    {` · ${day(entry.publishedAt)} – ${entry.until ? day(entry.until) : t.current}`}
                    {entry.app ? ` · ${t.app} ${entry.app}` : null}
                  </li>
                ))}
              </ul>
              {earlierEditions.length > 0 ? (
                <>
                  <p className="mt-2 font-sans">{t.noHistory}</p>
                  <ul className="mt-1 space-y-0.5">
                    {earlierEditions.map((e) => (
                      <li key={e.edition}>
                        {page.source === "edition" && page.edition === e.edition ? <strong className="text-muted">{`${t.edition} ${e.edition}`}</strong> : (
                          <Link href={`/${doc}?lang=${lang}&edition=${e.edition}`} className="underline underline-offset-2 hover:text-ink">{`${t.edition} ${e.edition}`}</Link>
                        )}
                        {` · ${day(e.published)} · ${t.app} ${e.app}`}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
        </footer>
      </article>
    </main>
  );
}

