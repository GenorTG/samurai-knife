import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountPerks, AuthFrame, RegisterChoices } from "@/components/account/AuthForms";
import { githubErrorText } from "@/components/account/GithubButton";
import { Notice } from "@/components/ui";
import { isPublicMode } from "@/lib/accounts/mode";
import { loadApp } from "@/lib/github-app/config";
import { legalVersion, recordLegalVersion } from "@/lib/legal/legal";
import { skipIfSignedIn } from "@/lib/accounts/viewer";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function RegisterPage({ searchParams }: PageProps<"/register">) {
  // Private mode has no registration at all (accounts come from `npm run accounts`).
  if (!isPublicMode()) notFound();
  await skipIfSignedIn(undefined);
  const params = await searchParams;
  const github = !!loadApp();
  // The version this page offers stays readable later (the account records only its fingerprint).
  recordLegalVersion();
  const error = githubErrorText(typeof params.github_error === "string" ? params.github_error : undefined, typeof params.github_message === "string" ? params.github_message : undefined);
  return (
    <AuthFrame title="Create your account" intro="Takes a minute: you confirm your email address before the first login." aside={<AccountPerks />}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <RegisterChoices terms={legalVersion()} github={github} />
    </AuthFrame>
  );
}
