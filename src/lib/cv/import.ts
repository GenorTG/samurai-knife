import { profileSchema, type CvData, type Profile } from "./schema";
import { mutateCv } from "./store";

export class CvImportError extends Error {}

function isEmpty(p: Profile): boolean {
  return !p.contact.name && p.experience.length === 0 && p.projects.length === 0 && !p.summary.pl && !p.summary.en;
}

/**
 * Replace the master profile with a complete, validated one (e.g. structured from a pasted CV by the assistant).
 * Refuses to overwrite a non-empty profile unless `overwrite` is true; the previous state stays undoable.
 */
export function importProfile(accountId: string, raw: unknown, overwrite: boolean): { data: CvData; replaced: boolean } {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CvImportError(`profile invalid at ${first.path.join("/") || "/"}: ${first.message}`);
  }
  const { data, result } = mutateCv(accountId, (current) => {
    if (!isEmpty(current.profile) && !overwrite) {
      throw new CvImportError("A profile already exists. Pass overwrite=true to replace it (the previous one stays undoable).");
    }
    return { data: { ...current, profile: parsed.data }, result: !isEmpty(current.profile) };
  });
  return { data, replaced: result };
}
