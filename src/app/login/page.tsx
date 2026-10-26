import type { Metadata } from "next";
import { AuthFrame, LoginForm } from "@/components/account/AuthForms";
import { GithubButton, githubErrorText } from "@/components/account/GithubButton";
import { Notice } from "@/components/ui";
import { isPublicMode } from "@/lib/accounts/mode";
import { loadApp } from "@/lib/github-app/config";
import { safeReturnPath } from "@/lib/safe-return";
import { skipIfSignedIn } from "@/lib/accounts/viewer";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("Log in") };
}
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { t } = await getT();
  const params = await searchParams;
  // Only a same-site path survives (the shared open-redirect rule); anything else is dropped here already.
  const next = typeof params.next === "string" ? safeReturnPath(params.next, "") || undefined : undefined;
  await skipIfSignedIn(next);
  const publicMode = isPublicMode();
  const github = publicMode && !!loadApp();
  const error = githubErrorText(typeof params.github_error === "string" ? params.github_error : undefined, typeof params.github_message === "string" ? params.github_message : undefined);
  return (
    <AuthFrame title={t("Log in")} intro={publicMode ? t("Use your username or email address.") : t("Accounts with a password log in here.")}>
      {error ? <Notice tone="error">{t(error)}</Notice> : null}
      {github ? (
        <div className="space-y-3">
          <GithubButton next={next} />
          <p className="text-center text-xs text-faint">{t("or with your password")}</p>
        </div>
      ) : null}
      <LoginForm publicMode={publicMode} next={next} />
    </AuthFrame>
  );
}
