/**
 * What OpenClaw Responses continuation needs from a provider config. Pure (no Node APIs):
 * the Settings form, `PUT /api/account/provider` and `/api/agent/chat` all use this one rule.
 *
 * The model pattern mirrors the gateway's own `isOpenClawAgentModelId` (http-utils):
 * `openclaw`, `openclaw/default`, or `openclaw/<agentId>` / `openclaw:<agentId>` / `agent:<agentId>`.
 */

const AGENT_MODEL = /^(?:openclaw[:/]|agent:)[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isOpenClawAgentModel(model: string): boolean {
  const raw = model.trim();
  const lowered = raw.toLowerCase();
  return lowered === "openclaw" || lowered === "openclaw/default" || AGENT_MODEL.test(raw);
}

/** null when the config can use Responses continuation, otherwise the message to show. */
export function openClawResponsesProblem(baseUrl: string, model: string): string | null {
  if (!isOpenClawAgentModel(model)) {
    return "OpenClaw Responses mode requires an OpenClaw agent target such as openclaw/knife-test.";
  }
  let path: string;
  try {
    path = new URL(baseUrl.trim()).pathname.replace(/\/+$/, "");
  } catch {
    return "OpenClaw Responses mode requires the gateway base URL to end in /v1.";
  }
  if (!path.endsWith("/v1")) return "OpenClaw Responses mode requires the gateway base URL to end in /v1.";
  return null;
}
