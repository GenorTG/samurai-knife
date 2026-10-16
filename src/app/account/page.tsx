import type { Metadata } from "next";
import { AccountSettings } from "@/components/account/AccountSettings";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage() {
  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-10 xl:px-8">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Account</h1>
        <AccountSettings />
      </div>
    </main>
  );
}
