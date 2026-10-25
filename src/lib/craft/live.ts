/**
 * The Craft app open on this page, for the assistant's craft_* tools (src/lib/agent-client/craft-live-tools.ts).
 * CraftFrame (src/tools/craft/CraftApp.tsx) registers it once the bridge reports that the app's own agent API exists
 * (`window.<app>.request`, sidecars/craft/knife-bridge/bridge.js "agent"), and clears it when the app goes away. Browser
 * only; one app at a time (one Craft page is open per tab).
 */

export interface CraftReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ActiveCraft {
  appId: string;
  appName: string;
  version: string;
  /** Functions the app's API has (request, execute, commands, inspect, screenshot, importFiles…). */
  methods: string[];
  /** Never rejects. `transfer`: ArrayBuffers handed over with the call (importFiles). */
  call: (method: string, args: unknown[], signal?: AbortSignal, transfer?: Transferable[]) => Promise<CraftReply>;
}

/** What the page knows about the open Craft app: none, an app without an agent API (yet), or one the assistant can drive. */
export type CraftPresence = { appId: string; appName: string; version: string; state: "probing" | "no-api" } | ({ state: "connected" } & ActiveCraft);

let presence: CraftPresence | null = null;

export function setCraftPresence(next: CraftPresence | null): void {
  presence = next;
}

/** Clear only if `appId` is still the registered app (an unmount after the next app registered must not clear it). */
export function clearCraftPresence(appId: string): void {
  if (presence?.appId === appId) presence = null;
}

export function craftPresence(): CraftPresence | null {
  return presence;
}

export function activeCraft(): ActiveCraft | null {
  return presence?.state === "connected" ? presence : null;
}
