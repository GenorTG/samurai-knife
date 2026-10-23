import Link from "next/link";
import { ARTCRAFT_APPS, SIDECARS } from "@/lib/services/definitions";

export const metadata = { title: "Credits" };

export default function CreditsPage() {
  const office = SIDECARS.find((service) => service.id === "office");
  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-5 py-8 sm:px-8">
      <header className="space-y-2 border-b border-line pb-5">
        <h1 className="text-3xl font-semibold tracking-tight">Credits &amp; open-source notices</h1>
        <p className="max-w-3xl text-muted">Attributions, source repositories and licence information for the third-party applications embedded in Smart Knife. Each project remains the work of its own authors; Smart Knife is not affiliated with or endorsed by them.</p>
        <Link className="text-sm text-accent-soft underline underline-offset-2" href="/tools/artcraft">Back to Craft apps</Link>
      </header>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">ArtCraft apps</h2>
          <p className="text-sm text-muted">Official, unmodified web builds, served by this instance. Each app’s bundled NOTICE and third-party licence texts are available from its source repository.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {ARTCRAFT_APPS.map((app) => (
            <article key={app.id} className="rounded-tool border border-line bg-surface p-4">
              <h3 className="font-semibold">{app.name}</h3>
              <p className="mt-1 text-sm text-muted">{app.kind} · {app.version}</p>
              <p className="mt-2 text-sm">ArtCraft team and contributors · {app.license}</p>
              <a className="mt-3 inline-block text-sm text-accent-soft underline underline-offset-2" href={app.repo} target="_blank" rel="noopener noreferrer">Source and bundled notices</a>
            </article>
          ))}
        </div>
      </section>

      {office ? (
        <section className="rounded-tool border border-line bg-surface p-4">
          <h2 className="text-xl font-semibold">{office.name}</h2>
          <p className="mt-2 text-sm text-muted">{office.description}</p>
          <p className="mt-2 text-sm">{office.license}</p>
          <a className="mt-3 inline-block text-sm text-accent-soft underline underline-offset-2" href={office.homepage} target="_blank" rel="noopener noreferrer">Source and licence</a>
        </section>
      ) : null}
      <p className="text-xs text-faint">Smart Knife’s in-page file bridge and account storage integration are maintained as part of Smart Knife; they do not change the upstream apps’ ownership or licences.</p>
    </main>
  );
}
