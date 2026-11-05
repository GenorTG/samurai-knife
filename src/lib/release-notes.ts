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
    version: "0.15.3",
    date: "2026-11-05",
    features: [
      msg("The assistant uses far fewer tokens: it reads the instructions for a specialist tool only when it needs them, forgets old tool output sooner, and stops when it keeps repeating a step that gives the same answer."),
    ],
    fixes: [],
  },
  {
    version: "0.15.2",
    date: "2026-11-05",
    features: [],
    fixes: [
      msg("Account details and sign-ins move to a database that is faster to reach for many people at once. Nothing changes in how you use the site."),
    ],
  },
  {
    version: "0.15.1",
    date: "2026-11-05",
    features: [],
    fixes: [
      msg("The home page shows the AI assistant and the website check again."),
      msg("Pages now say clearly whose software Euro-Office and the Craft apps are: open-source projects we only host, with no ties either way."),
    ],
  },
  {
    version: "0.15.0",
    date: "2026-11-05",
    features: [
      msg("Clearer names and categories: every tool now says in plain words what it does, and tools are grouped by the job you want done. Tool sets show what each group can replace."),
      msg("A short welcome guide for new accounts: choose your language and what you came for, and it takes you straight there. You can open it again from the home page."),
      msg("The CV builder has a new step-by-step wizard: one topic at a time, with examples, and only your name is required. No AI model is needed, and what you write is kept until you finish. You can also start from a CV file you already have."),
    ],
    fixes: [],
  },
  {
    version: "0.14.0",
    date: "2026-11-04",
    features: [
      msg("Every tool has a page that explains it: what it is for, what you can do, who it is for, where it runs and whether your files leave your device, what the assistant can do there, with a screenshot. Tool cards open it first; you can open tools straight away instead, or skip it for a tool you know."),
      msg("Smart Knife now speaks Polish first: pages, emails, the Terms and the privacy notice open in Polish unless you chose English or your browser asks only for English. The language switch in the top bar changes it at any time."),
    ],
    fixes: [],
  },
  {
    version: "0.13.0",
    date: "2026-10-30",
    features: [
      msg("Several assistant chats can work at the same time: switch to another chat while one is still working, and it carries on in the background. A small dot in the chat list shows which chats are running."),
      msg("Tasks: the assistant can keep a saved task list for longer jobs (a website update, a CV for an offer), with steps, the next step and a history, so a lost chat or another model can carry on. Open it with the Tasks button in the assistant."),
      msg("The assistant can tell whether your model sees images (Detect in Provider settings), and you can set how many steps one message may take (Settings > Turn limit)."),
      msg("You can cap how many input tokens one message may use (Settings > Turn limit), and the line under each answer shows how much of the prompt came from the provider's cache."),
      msg("Claude models from Anthropic can be used as the assistant's provider."),
      msg("Website score: \"Fix all findings\" asks the assistant to fix every finding it can in one go, check the preview and describe the result in the pull request."),
      msg("Website changes are checked in one step: after a change the assistant waits for the preview, checks it and the automatic tests, and tells you what got better or worse since the last check."),
      msg("Your account has its own MCP address for outside AI tools (Claude Code, Cursor, OpenClaw), and an MCP key can be read-only. Outside tools can now also read your assistant chats and tasks."),
    ],
    fixes: [
      msg("Outside AI tools no longer give up on long website screenshots and checks: a call that takes longer than about 25 seconds carries on in the background and the tool collects the result when it is ready. Screenshots of sites with analytics or chat widgets are also faster."),
      msg("When the assistant stops before finishing (an error or the turn limit), your request is kept as a paused task in Tasks, so you can continue it later."),
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
  9: msg("The privacy notice says that account details, sign-in sessions, MCP keys and AI provider profiles are kept in a database on a rented server in Germany (the same provider that relays our e-mail), on an encrypted volume, reached only through an encrypted tunnel, with a copy on our own server in Poland. Passwords, tokens and API keys stay hashed or encrypted there."),
  8: msg("The privacy notice describes the browser setting that decides whether tool cards open a tool's description page first, and that Smart Knife is shown in Polish unless you choose English."),
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
