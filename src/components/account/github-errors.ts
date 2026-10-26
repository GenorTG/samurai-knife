import { msg } from "@/lib/i18n/msg";

/** Plain module (no "use client"): server pages and client components both read the GitHub sign-in error texts. */
const MESSAGES: Record<string, string> = {
  expired: msg("The GitHub sign-in took too long or was opened in another browser: start it again."),
  denied: msg("GitHub sign-in was cancelled."),
  not_configured: msg("This server has no GitHub App yet."),
  public_only: msg("Signing in with GitHub is available on the public server only."),
  github_taken: msg("That GitHub user is already linked to another account."),
  session_changed: msg("You were signed in as someone else when GitHub answered: start again."),
  exchange_failed: msg("GitHub did not accept the sign-in: start again."),
  rate_limited: msg("Too many GitHub sign-ins from here. Wait a few minutes and start again."),
  terms_required: msg("To create an account with GitHub, accept the Terms of Service and the privacy notice first."),
  terms_changed: msg("The Terms of Service or privacy notice changed meanwhile: read them and accept them again."),
};

/** The message for `?github_error=` (the server's own text in `github_message` wins). */
export function githubErrorText(code: string | undefined, message: string | undefined): string | null {
  if (!code) return null;
  return (message && message.length < 300 ? message : null) ?? MESSAGES[code] ?? msg("GitHub sign-in failed.");
}
