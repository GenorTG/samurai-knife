import type { Metadata } from "next";
import { AuthFrame, LoginForm } from "@/components/account/AuthForms";
import { GithubButton, githubErrorText } from "@/components/account/GithubButton";
import { Notice } from "@/components/ui";
import { isPublicMode } from "@/lib/accounts/mode";
import { loadApp } from "@/lib/github-app/config";
import { safeReturnPath } from "@/lib/safe-return";

export const metadata: Metadata = { title: "Log in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  // Only a same-site path survives (the shared open-redirect rule); anything else is dropped here already.
  const next = typeof params.next === "string" ? safeReturnPath(params.next, "") || undefined : undefined;
  const publicMode = isPublicMode();
  const github = publicMode && !!loadApp();
  const error = githubErrorText(typeof params.github_error === "string" ? params.github_error : undefined, typeof params.github_message === "string" ? params.github_message : undefined);
  return (
    <AuthFrame title="Log in" intro={publicMode ? "Use your username or email address." : "Accounts with a password log in here."}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {github ? (
        <div className="space-y-3">
          <GithubButton next={next} />
          <p className="text-center text-xs text-faint">or with your password</p>
        </div>
      ) : null}
      <LoginForm publicMode={publicMode} next={next} />
    </AuthFrame>
  );
}
