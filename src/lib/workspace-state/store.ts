import { existsSync } from "node:fs";
import { accountScope } from "@/lib/storage/scope";
import { writeAccountFile } from "@/lib/storage/quota";
import { readAccountText } from "@/lib/storage/sealed";

/** Browser-tool drafts: one sealed JSON file per account (`workspace/<id>.json.enc`, see src/lib/storage/sealed.ts). */
const MAX_BYTES = 2 * 1024 * 1024;

export type WorkspaceState = Record<string, Record<string, string | boolean>>;

function validState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 160) return false;
  return entries.every(([tool, fields]) =>
    /^[a-z0-9-]{1,80}$/.test(tool) &&
    !!fields && typeof fields === "object" && !Array.isArray(fields) &&
    Object.entries(fields).length <= 300 &&
    Object.entries(fields).every(([key, field]) =>
      key.length <= 240 && (typeof field === "boolean" || (typeof field === "string" && field.length <= 100_000)),
    ),
  );
}

export function readWorkspaceState(accountId: string): WorkspaceState {
  const path = accountScope(accountId).workspaceFile;
  if (!existsSync(path)) return {};
  const state: unknown = JSON.parse(readAccountText(accountId, path));
  if (!validState(state)) throw new Error("stored workspace state is invalid");
  return state;
}

export function saveWorkspaceState(accountId: string, state: WorkspaceState): void {
  if (!validState(state)) throw new Error("workspace state is invalid");
  const contents = JSON.stringify(state);
  if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error("workspace state exceeds 2 MiB");
  writeAccountFile(accountId, accountScope(accountId).workspaceFile, contents);
}

export function saveWorkspaceTool(accountId: string, tool: string, fields: Record<string, string | boolean>): void {
  const previous = readWorkspaceState(accountId);
  saveWorkspaceState(accountId, { ...previous, [tool]: fields });
}

/** False when the tool had no draft. */
export function deleteWorkspaceTool(accountId: string, tool: string): boolean {
  const previous = readWorkspaceState(accountId);
  if (!(tool in previous)) return false;
  saveWorkspaceState(accountId, Object.fromEntries(Object.entries(previous).filter(([name]) => name !== tool)));
  return true;
}
