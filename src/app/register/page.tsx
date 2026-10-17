import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountPerks, AuthFrame, RegisterForm } from "@/components/account/AuthForms";
import { GithubButton } from "@/components/account/GithubButton";
import { isPublicMode } from "@/lib/accounts/mode";
import { loadApp } from "@/lib/github-app/config";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  // Private mode has no registration at all (accounts come from `npm run accounts`).
  if (!isPublicMode()) notFound();
  const github = !!loadApp();
  return (
    <AuthFrame title="Create your account" intro="Takes a minute: you confirm your email address before the first login." aside={<AccountPerks />}>
      {github ? (
        <div className="space-y-3">
          <GithubButton label="Sign up with GitHub" />
          <p className="text-center text-xs text-faint">GitHub&apos;s verified email is used; no password needed. Or create an account with a password:</p>
        </div>
      ) : null}
      <RegisterForm />
    </AuthFrame>
  );
}
