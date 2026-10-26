/** Browser-safe setup recipes. Only defaults and public documentation; never credentials or tokens. */
import { msg } from "@/lib/i18n/msg";
import { credentialType, oauthPreset } from "./credential-types";

export interface CredentialRecipe {
  id: string;
  label: string;
  type: string;
  fields: Record<string, string | boolean>;
  instructions: string;
  docsUrl: string;
}

const oauth = (id: string, label: string, preset: string, scope: string, instructions: string, docsUrl: string): CredentialRecipe => ({
  id, label, type: "oAuth2Api", fields: { preset, scope }, instructions, docsUrl,
});
const bearer = (id: string, label: string, instructions: string, docsUrl: string): CredentialRecipe => ({
  id, label, type: "httpBearerAuth", fields: {}, instructions, docsUrl,
});

export const CREDENTIAL_RECIPES: readonly CredentialRecipe[] = [
  oauth("google-sheets", msg("Google Sheets — OAuth2"), "google", "https://www.googleapis.com/auth/spreadsheets", msg("Enable the Google Sheets API in your Cloud project, configure the consent screen and create a Web application client. Add the redirect URI below. Add test users while the app is in testing."), "https://developers.google.com/sheets/api/guides/authorizing"),
  oauth("google-drive", msg("Google Drive — OAuth2"), "google", "https://www.googleapis.com/auth/drive.file", msg("Enable the Drive API and create a Web application OAuth client. This scope accesses files created by or explicitly shared with the app, not every existing file in your Drive. Broader access needs a different scope and may require verification."), "https://developers.google.com/drive/api/guides/api-specific-auth"),
  oauth("google-calendar", msg("Google Calendar — OAuth2"), "google", "https://www.googleapis.com/auth/calendar.events", msg("Enable the Calendar API and create a Web application OAuth client. This scope supports event operations; listing calendar metadata may need an additional calendar scope."), "https://developers.google.com/calendar/api/auth"),
  oauth("github", msg("GitHub — OAuth2"), "github", "repo read:user", msg("Register your own OAuth app and its callback URI. The repo scope grants broad private repository access; for a narrower installation use a fine-grained personal token instead."), "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps"),
  bearer("github-token", msg("GitHub — personal token"), msg("Create a fine-grained personal access token limited to the repositories and permissions your operations need. Paste the token below."), "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"),
  oauth("gitlab", msg("GitLab.com — OAuth2"), "gitlab", "api", msg("Register an application on GitLab.com with the callback URI below. The api scope allows writes; use a read-only token if you only need read operations."), "https://docs.gitlab.com/api/oauth2/"),
  oauth("slack", msg("Slack — bot OAuth2"), "slack", "chat:write,channels:read", msg("Create a Slack app, add the redirect URI and bot scopes, and install it in your workspace. Invite the bot to channels it should use. Additional operations may require extra scopes."), "https://docs.slack.dev/authentication/installing-with-oauth"),
  bearer("slack-token", msg("Slack — bot token"), msg("Install your Slack app and paste its bot token (xoxb). Grant chat:write for messages and channels:read for channel listings. Invite the bot to the target channel."), "https://docs.slack.dev/authentication/tokens"),
  oauth("notion", msg("Notion — public connection OAuth2"), "notion", "", msg("Create a public Notion connection and configure its redirect URI. The user must select/share pages with the connection; access is limited to those pages and the connection capabilities."), "https://developers.notion.com/docs/authorization"),
  bearer("notion-token", msg("Notion — internal connection token"), msg("Create an internal connection, set its capabilities and share the pages it should access using Add connections. Paste its API token below."), "https://developers.notion.com/docs/authorization"),
  bearer("airtable", msg("Airtable — personal access token"), msg("Create a personal access token with data.records:read and, for writes, data.records:write; grant access only to the bases you need. Legacy Airtable API keys are not supported."), "https://airtable.com/developers/web/guides/personal-access-tokens"),
  bearer("hubspot", msg("HubSpot — private app token"), msg("Create a private app and grant the CRM object scopes needed by your operations (for example crm.objects.contacts.read/write). Multi-account public apps require OAuth, configured with the generic OAuth2 type."), "https://developers.hubspot.com/docs/apps/legacy-apps/authentication/intro-to-auth"),
  bearer("stripe", msg("Stripe — restricted or secret key"), msg("Use a test-mode restricted key while developing, with only the resources your workflow needs. Paste that key as the bearer token. A live-mode key can create real resources."), "https://docs.stripe.com/keys"),
  oauth("microsoft-outlook", msg("Microsoft Outlook — OAuth2"), "microsoft", "offline_access User.Read Mail.Read Mail.Send", msg("Register a Web application in Microsoft Entra and add the callback URI below. Add delegated Mail.Read and Mail.Send permissions; your tenant may require administrator consent. Create and paste a client secret value, not its ID."), "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow"),
  oauth("microsoft-teams", msg("Microsoft Teams — OAuth2"), "microsoft", "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Send", msg("Register a Web application in Microsoft Entra with delegated Teams/channel/message permissions and the callback URI. Teams access depends on membership, licensing and tenant consent policy."), "https://learn.microsoft.com/en-us/graph/permissions-reference"),
];

export function credentialRecipe(id: string): CredentialRecipe | undefined {
  return CREDENTIAL_RECIPES.find((entry) => entry.id === id);
}

/** Materialise defaults before rendering AND saving; a displayed default must not be silently omitted. */
export function credentialDefaults(type: string): Record<string, string | boolean> {
  const defaults = Object.fromEntries((credentialType(type)?.fields ?? []).filter((field) => !field.managed && field.default !== undefined).map((field) => [field.name, field.default!]));
  const preset = type === "oAuth2Api" ? oauthPreset(defaults.preset) : undefined;
  return { ...defaults, ...(preset ? { authUrl: preset.authUrl, tokenUrl: preset.tokenUrl, scope: preset.scope, authentication: preset.authentication ?? "body" } : {}) };
}

export function recipeValues(recipe: CredentialRecipe): Record<string, string | boolean> {
  const preset = oauthPreset(recipe.fields.preset);
  return {
    ...credentialDefaults(recipe.type),
    ...(preset ? { authUrl: preset.authUrl, tokenUrl: preset.tokenUrl, scope: preset.scope, authentication: preset.authentication ?? "body" } : {}),
    ...recipe.fields,
  };
}
