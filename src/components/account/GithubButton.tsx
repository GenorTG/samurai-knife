const BUTTON_CLASS =
  "inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-semibold text-ink shadow-xs transition-colors";

/**
 * "Continue with GitHub" (public mode, when the server has a GitHub App). A plain link: the flow is server redirects.
 * `purpose="register"` carries the legal version the person accepted (`terms`); without it (`disabled`) it is inert.
 */
export function GithubButton({ next, label = "Continue with GitHub", purpose = "login", terms, disabled = false }: { next?: string; label?: string; purpose?: "login" | "register"; terms?: string; disabled?: boolean }) {
  const href = `/api/github/start?purpose=${purpose}${next ? `&returnTo=${encodeURIComponent(next)}` : ""}${terms ? `&terms=${encodeURIComponent(terms)}` : ""}`;
  if (disabled) {
    return (
      <span role="link" aria-disabled="true" className={`${BUTTON_CLASS} cursor-not-allowed opacity-50`}>
        <GithubMark />
        {label}
      </span>
    );
  }
  return (
    <a href={href} className={`${BUTTON_CLASS} hover:bg-raised`}>
      <GithubMark />
      {label}
    </a>
  );
}

function GithubMark() {
  return (
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
  );
}

const MESSAGES: Record<string, string> = {
  expired: "The GitHub sign-in took too long or was opened in another browser: start it again.",
  denied: "GitHub sign-in was cancelled.",
  not_configured: "This server has no GitHub App yet.",
  public_only: "Signing in with GitHub is available on the public server only.",
  github_taken: "That GitHub user is already linked to another account.",
  session_changed: "You were signed in as someone else when GitHub answered: start again.",
  exchange_failed: "GitHub did not accept the sign-in: start again.",
  rate_limited: "Too many GitHub sign-ins from here. Wait a few minutes and start again.",
  terms_required: "To create an account with GitHub, accept the Terms of Service and the privacy notice first.",
  terms_changed: "The Terms of Service or privacy notice changed meanwhile: read them and accept them again.",
};

/** The message for `?github_error=` (the server's own text in `github_message` wins). */
export function githubErrorText(code: string | undefined, message: string | undefined): string | null {
  if (!code) return null;
  return (message && message.length < 300 ? message : null) ?? MESSAGES[code] ?? "GitHub sign-in failed.";
}
