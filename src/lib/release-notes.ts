import { msg } from "@/lib/i18n/msg";

/**
 * What changed, for PEOPLE (the "What's new" window after an update, the /changelog page). Plain words, no tool names
 * (those are in src/lib/whats-new.ts, for agents). English is the key; Polish comes from the catalogue (`t(item)`).
 * One entry per MAJOR.MINOR.PATCH release, newest first; tests/release_notes.test.mjs requires the package.json version
 * to have one. Pure data (browser and server).
 */
export interface ReleaseNote {
  version: string;
  date: string;
  features: string[];
  fixes: string[];
}

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: "0.13.0",
    date: "2026-10-30",
    features: [
      msg("Several assistant chats can work at the same time: switch to another chat while one is still working, and it carries on in the background. A small dot in the chat list shows which chats are running."),
      msg("Tasks: the assistant can keep a saved task list for longer jobs (a website update, a CV for an offer), with steps, the next step and a history, so a lost chat or another model can carry on. Open it with the Tasks button in the assistant."),
      msg("The assistant can tell whether your model sees images (Detect in Provider settings), and you can set how many steps one message may take (Settings > Turn limit)."),
      msg("Claude models from Anthropic can be used as the assistant's provider."),
      msg("Your account has its own MCP address for outside AI tools (Claude Code, Cursor, OpenClaw), and an MCP key can be read-only. Outside tools can now also read your assistant chats and tasks."),
    ],
    fixes: [
      msg("Chat history is kept when you switch to another provider or model, and chats saved before can be brought back (Settings > Recover earlier chats)."),
      msg("The assistant no longer loses its previous answer when a long chat is shortened for the model."),
      msg("Describing a screenshot with a model that thinks first no longer comes back empty."),
      msg("Website audit: robots.txt, sitemap.xml and llms.txt are checked as files instead of as pages, links from your CV are found on the site (also in structured data), a page drawn only by JavaScript is one finding, and PageSpeed scores show how much they vary between runs."),
    ],
  },
];

/** A plain summary of each edition of the default Terms and privacy notice, for people who already accepted one. */
export const LEGAL_EDITION_NOTES: Readonly<Record<number, string>> = {
  6: msg("The privacy notice describes checking whether a model sees images (one generated test picture; the shared list of answers does not record who checked) and your turn limit setting."),
  7: msg("The privacy notice now describes saved assistant tasks, which release notes you have already seen, and that outside AI tools you connect with your MCP key can read your assistant chats."),
};

/** "0.13.0.27" or "0.13.0" -> [0, 13, 0]; null when it is not a version. */
export function releaseOf(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 on MAJOR.MINOR.PATCH (the build part is ignored). */
export function compareRelease(a: string, b: string): number {
  const x = releaseOf(a);
  const y = releaseOf(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export interface SeenState {
  /** MAJOR.MINOR.PATCH whose notes the user last saw; null = never recorded (an account from before 0.13.0). */
  version: string | null;
  legalEdition: number | null;
}

/**
 * What the "What's new" window shows: the notes newer than what was seen (an account that never recorded one gets the
 * current minor's notes only, not the whole history), and the legal editions after the seen one (unknown: the current
 * edition's summary). Nothing to show = null.
 */
export function unseen(seen: SeenState | null, current: { version: string; legalEdition: number | null }): { notes: ReleaseNote[]; legal: { edition: number; summary: string }[] } | null {
  const now = releaseOf(current.version);
  if (!now) return null;
  const notes = RELEASE_NOTES.filter((note) => {
    if (compareRelease(note.version, current.version) > 0) return false;
    if (seen?.version) return compareRelease(note.version, seen.version) > 0;
    const r = releaseOf(note.version);
    return !!r && r[0] === now[0] && r[1] === now[1];
  });
  const legal: { edition: number; summary: string }[] = [];
  if (current.legalEdition !== null && seen?.legalEdition !== current.legalEdition) {
    const from = seen?.legalEdition ?? current.legalEdition - 1;
    for (let e = current.legalEdition; e > from && legal.length < 3; e -= 1) if (LEGAL_EDITION_NOTES[e]) legal.push({ edition: e, summary: LEGAL_EDITION_NOTES[e] });
  }
  return notes.length || legal.length ? { notes, legal } : null;
}
