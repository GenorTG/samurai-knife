/**
 * The build this browser tab was rendered with (the shell's version chip, set by AppShell from the server's VERSION
 * file at page load) and the build the server runs now (GET /api/system/version). After a release a tab that was not
 * reloaded keeps its old code: the assistant's instructions and tool list are the old ones, so both the shell (a
 * banner) and the assistant (its system prompt) say so. Browser only.
 */
let loaded = "";

export function setLoadedVersion(version: string): void {
  if (version) loaded = version;
}

export function loadedVersion(): string {
  return loaded;
}

/** null when the server could not be asked (offline, signed out): never treated as a new version. */
export async function fetchServerVersion(signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch("/api/system/version", { cache: "no-store", credentials: "same-origin", signal });
    const body = (await r.json().catch(() => null)) as { version?: unknown } | null;
    return r.ok && typeof body?.version === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/** The server runs another build than this tab (null = unknown, treated as current). */
export function isStale(server: string | null): boolean {
  return !!loaded && !!server && server !== loaded;
}
