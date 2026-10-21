import type { Metadata } from "next";
import { requireSignIn } from "@/lib/accounts/viewer";
import Link from "next/link";
import { AccountSettings } from "@/components/account/AccountSettings";

export const metadata: Metadata = { title: "Account" };

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  await requireSignIn("/account");
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Account</h1>
        <AccountSettings />
        <p className="border-t border-line pt-4 text-xs text-faint">
          <Link href="/terms" className="hover:text-ink">Terms of Service</Link> · <Link href="/privacy" className="hover:text-ink">Privacy notice</Link>
        </p>
      </div>
    </main>
  );
}
