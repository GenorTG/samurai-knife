import type { Metadata } from "next";
import { requireSignIn, sessionAccount } from "@/lib/accounts/viewer";
import Link from "next/link";
import { AccountSettings } from "@/components/account/AccountSettings";
import { editionOn, legalRecord, legalVersion } from "@/lib/legal/legal";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Account") };
}

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const { t } = await getT();
  await requireSignIn("/account");
  const account = await sessionAccount();
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t("Account")}</h1>
        <AccountSettings />
        <div className="space-y-1 border-t border-line pt-4 text-xs text-faint">
          <p>
            <Link href="/terms" className="hover:text-ink">{t("Terms of Service")}</Link> · <Link href="/privacy" className="hover:text-ink">{t("Privacy notice")}</Link>
          </p>
          {account?.termsVersion && account.termsAcceptedAt ? <Accepted version={account.termsVersion} at={account.termsAcceptedAt} /> : null}
        </div>
      </div>
    </main>
  );
}

const LINK = "underline underline-offset-2 hover:text-ink";

/** Which version of the Terms and privacy notice this account accepted at sign-up, and whether a newer one exists. */
async function Accepted({ version, at }: { version: string; at: string }) {
  const { t: tr } = await getT();
  const record = legalRecord(version);
  const current = legalVersion();
  // Accepted before this instance kept its version history: the edition of the default texts in force that day.
  const edition = record ? null : editionOn(at);
  return (
    <p data-terms-accepted={version}>
      {tr("You accepted version")}{" "} <span className="font-mono">{version}</span>
      {record?.edition ? ` (edition ${record.edition})` : null} on {at.slice(0, 10)}
      {version === current ? ", the current one. " : ". "}
      {record ? <Link href={`/terms?version=${encodeURIComponent(version)}`} className={LINK}>{tr("Read it")}</Link> : null}
      {edition ? <Link href={`/terms?edition=${edition.edition}`} className={LINK}>{`Read edition ${edition.edition}`}</Link> : null}
      {version !== current ? (
        <>
          {" · "}{tr("A newer version applies now: what changed in the")}{" "} <Link href="/terms#history" className={LINK}>{tr("Terms")}</Link> {" "}{tr("and the")}{" "}
          <Link href="/privacy#versions" className={LINK}>{tr("privacy notice")}</Link>.
        </>
      ) : null}
    </p>
  );
}
