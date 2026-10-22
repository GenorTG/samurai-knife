/**
 * Credential types (docs/WORKFLOWS.md "Rules": per account, sealed, hints only after saving). Isomorphic metadata: the
 * editor renders the form from `fields`; the server keeps `secret` fields out of every response. OAuth2 uses the
 * user's own app: presets only fill the provider's endpoints and usual scopes; the client id and secret are theirs.
 */

export interface CredentialField {
  name: string;
  label: string;
  type: "string" | "password" | "text" | "options" | "boolean";
  secret?: boolean;
  required?: boolean;
  default?: string | boolean;
  placeholder?: string;
  description?: string;
  options?: { value: string; label: string }[];
  /** Set by the OAuth flow, never typed. */
  managed?: boolean;
}

export interface CredentialType {
  type: string;
  label: string;
  description: string;
  fields: CredentialField[];
  /** OAuth2: needs Connect after saving. */
  oauth2?: boolean;
}

export interface OAuthPreset {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scope: string;
  /** Extra query parameters for the authorization URL. */
  authQuery?: Record<string, string>;
  /** Where the user registers the app (shown next to the form). */
  consoleUrl: string;
  /** Client authentication at the token endpoint. */
  authentication?: "header" | "body";
}

export const OAUTH_PRESETS: OAuthPreset[] = [
  {
    id: "google",
    label: "Google (Sheets, Drive, Gmail, Calendar, Analytics…)",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    authQuery: { access_type: "offline", prompt: "consent" },
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    authentication: "body",
  },
  {
    id: "meta",
    label: "Meta / Facebook (Graph API, Instagram, WhatsApp)",
    authUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "public_profile,email,pages_show_list,pages_read_engagement",
    consoleUrl: "https://developers.facebook.com/apps/",
    authentication: "body",
  },
  {
    id: "microsoft",
    label: "Microsoft (Outlook, OneDrive, Teams, Excel)",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access User.Read Mail.Read Files.ReadWrite",
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    authentication: "body",
  },
  { id: "github", label: "GitHub", authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", scope: "repo read:user", consoleUrl: "https://github.com/settings/developers", authentication: "body" },
  { id: "slack", label: "Slack", authUrl: "https://slack.com/oauth/v2/authorize", tokenUrl: "https://slack.com/api/oauth.v2.access", scope: "chat:write channels:read", consoleUrl: "https://api.slack.com/apps", authentication: "body" },
  { id: "discord", label: "Discord", authUrl: "https://discord.com/oauth2/authorize", tokenUrl: "https://discord.com/api/oauth2/token", scope: "identify guilds", consoleUrl: "https://discord.com/developers/applications" },
  { id: "notion", label: "Notion", authUrl: "https://api.notion.com/v1/oauth/authorize", tokenUrl: "https://api.notion.com/v1/oauth/token", scope: "", authQuery: { owner: "user" }, consoleUrl: "https://www.notion.so/my-integrations" },
  { id: "custom", label: "Other (enter the endpoints)", authUrl: "", tokenUrl: "", scope: "", consoleUrl: "" },
];

export const CREDENTIAL_TYPES: CredentialType[] = [
  {
    type: "httpHeaderAuth",
    label: "Header auth",
    description: "One header sent with every request (an API key header, for example).",
    fields: [
      { name: "name", label: "Header name", type: "string", required: true, placeholder: "X-API-Key" },
      { name: "value", label: "Value", type: "password", secret: true, required: true },
    ],
  },
  {
    type: "httpBearerAuth",
    label: "Bearer token",
    description: "Authorization: Bearer <token>.",
    fields: [{ name: "token", label: "Token", type: "password", secret: true, required: true }],
  },
  {
    type: "httpBasicAuth",
    label: "Basic auth",
    description: "User name and password (also the Webhook node's Basic auth).",
    fields: [
      { name: "user", label: "User", type: "string", required: true },
      { name: "password", label: "Password", type: "password", secret: true, required: true },
    ],
  },
  {
    type: "httpQueryAuth",
    label: "Query auth",
    description: "A query parameter added to every URL (?api_key=…).",
    fields: [
      { name: "name", label: "Parameter name", type: "string", required: true, placeholder: "api_key" },
      { name: "value", label: "Value", type: "password", secret: true, required: true },
    ],
  },
  {
    type: "httpCustomAuth",
    label: "Custom auth (JSON)",
    description: 'Headers, query and body fields as JSON: {"headers": {…}, "qs": {…}, "body": {…}}.',
    fields: [{ name: "json", label: "JSON", type: "text", secret: true, required: true, placeholder: '{ "headers": { "X-Key": "…" } }' }],
  },
  {
    type: "oAuth2Api",
    label: "OAuth2 (your own app)",
    description: "Register an app with the provider, paste its client id and secret, then press Connect.",
    oauth2: true,
    fields: [
      { name: "preset", label: "Provider", type: "options", default: "google", options: OAUTH_PRESETS.map((p) => ({ value: p.id, label: p.label })) },
      { name: "clientId", label: "Client ID", type: "string", required: true },
      { name: "clientSecret", label: "Client secret", type: "password", secret: true, required: true },
      { name: "authUrl", label: "Authorization URL", type: "string", description: "Filled from the provider; change only for 'Other'." },
      { name: "tokenUrl", label: "Token URL", type: "string" },
      { name: "scope", label: "Scopes", type: "string", description: "Space- or comma-separated, as the provider expects." },
      { name: "authentication", label: "Send client credentials", type: "options", default: "body", options: [{ value: "body", label: "In the body" }, { value: "header", label: "As Basic auth header" }] },
      { name: "accessToken", label: "Access token", type: "password", secret: true, managed: true },
      { name: "refreshToken", label: "Refresh token", type: "password", secret: true, managed: true },
      { name: "tokenType", label: "Token type", type: "string", managed: true },
      { name: "expiresAt", label: "Expires", type: "string", managed: true },
      { name: "connectedAt", label: "Connected", type: "string", managed: true },
    ],
  },
  {
    type: "jwtAuth",
    label: "JWT key",
    description: "Key for the JWT node: a shared secret (HS…) or a PEM key pair (RS…/ES256).",
    fields: [
      { name: "algorithm", label: "Algorithm", type: "options", default: "HS256", options: ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "ES256"].map((value) => ({ value, label: value })) },
      { name: "secret", label: "Secret (HS…)", type: "password", secret: true },
      { name: "privateKey", label: "Private key PEM (RS…/ES…)", type: "text", secret: true },
      { name: "publicKey", label: "Public key PEM (verify only)", type: "text" },
    ],
  },
  {
    type: "totpApi",
    label: "TOTP secret",
    description: "The base32 secret of an authenticator (2FA) entry.",
    fields: [
      { name: "secret", label: "Secret (base32)", type: "password", secret: true, required: true },
      { name: "label", label: "Label", type: "string" },
    ],
  },
  {
    type: "smtp",
    label: "SMTP (your mail server)",
    description: "Your own mail account for the Send Email node. Never the instance's mailer.",
    fields: [
      { name: "host", label: "Host", type: "string", required: true, placeholder: "smtp.example.com" },
      { name: "port", label: "Port", type: "string", default: "587" },
      { name: "secure", label: "TLS from the start (port 465)", type: "boolean", default: false },
      { name: "user", label: "User", type: "string" },
      { name: "password", label: "Password", type: "password", secret: true },
    ],
  },
];

const BY_TYPE = new Map(CREDENTIAL_TYPES.map((type) => [type.type, type]));

export function credentialType(type: string): CredentialType | undefined {
  return BY_TYPE.get(type);
}

export function oauthPreset(id: unknown): OAuthPreset | undefined {
  return OAUTH_PRESETS.find((preset) => preset.id === id);
}
