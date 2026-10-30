import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { RELEASE_NOTES } from "@/lib/release-notes";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("What's new in Smart Knife") };
}

/** Every release's notes for people (src/lib/release-notes.ts). Public in both modes: nothing here is private. */
export default async function Page() {
  const { t } = await getT();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-ink">
      <h1 className="text-2xl font-semibold">{t("What's new in Smart Knife")}</h1>
      {RELEASE_NOTES.map((note) => (
        <section key={note.version} className="mt-6" aria-labelledby={`v${note.version}`}>
          <h2 id={`v${note.version}`} className="text-lg font-semibold">
            {note.version} <span className="text-sm font-normal text-muted">· {note.date}</span>
          </h2>
          {note.features.length ? (
            <>
              <h3 className="sk-label mt-2">{t("New")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-muted">{note.features.map((item) => <li key={item}>{t(item)}</li>)}</ul>
            </>
          ) : null}
          {note.fixes.length ? (
            <>
              <h3 className="sk-label mt-2">{t("Fixed")}</h3>
              <ul className="list-disc space-y-1 pl-5 text-muted">{note.fixes.map((item) => <li key={item}>{t(item)}</li>)}</ul>
            </>
          ) : null}
        </section>
      ))}
    </main>
  );
}
