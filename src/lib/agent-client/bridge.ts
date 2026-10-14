/**
 * Tiny event bridge between the app shell (top bar, palette, shortcuts) and the
 * assistant widget, which lives outside the shell tree. Neither side imports
 * the other; both just emit/listen for these window events.
 */

export const AGENT_EVENTS = {
  /** Open the panel; `detail.prompt` (optional) is sent as soon as the account is ready. */
  open: "sk:agent-open",
  /** Stop the run in progress. */
  stop: "sk:agent-stop",
} as const;

export interface AgentOpenDetail {
  prompt?: string;
}

export function openAssistant(prompt?: string): void {
  window.dispatchEvent(new CustomEvent<AgentOpenDetail>(AGENT_EVENTS.open, { detail: { prompt } }));
}

export function stopAssistant(): void {
  window.dispatchEvent(new CustomEvent(AGENT_EVENTS.stop));
}
