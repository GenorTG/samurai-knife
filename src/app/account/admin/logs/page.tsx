import type { Metadata } from "next";
import Link from "next/link";
import { isAdmin } from "@/lib/accounts/authz";
import { isPublicMode } from "@/lib/accounts/mode";
import { requireSignIn, sessionAccount } from "@/lib/accounts/viewer";
import { AdminLogs } from "@/components/account/AdminLogs";
import { Notice } from "@/components/ui";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Server logs") };
}
export const dynamic = "force-dynamic";

/**
 * Read-only log viewer (admins only; `GET /api/admin/logs` answers 403 to everyone else). A signed-in non-admin gets the
 * refusal rendered here and no viewer at all, so the page never asks the API for anything.
 */
export default async function AdminLogsPage() {
  const { t } = await getT();
  await requireSignIn("/account/admin/logs");
  const account = isPublicMode() ? await sessionAccount() : null;
  const allowed = !isPublicMode() || (account !== null && isAdmin(account));
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="space-y-4">
        <header className="space-y-1.5">
          <p className="text-sm text-muted"><Link className="text-accent-soft underline underline-offset-2" href="/account/admin">{t("Users")}</Link> {" "}{t("/ Server logs")}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("Server logs")}</h1>
          <p className="text-[15px] text-muted">{t("The server's own log files, newest first. Read-only: files leave by retention, never from here.")}</p>
        </header>
        {allowed ? <AdminLogs /> : <Notice tone="error">{t("An administrator has to read the server logs.")}</Notice>}
      </div>
    </main>
  );
}
