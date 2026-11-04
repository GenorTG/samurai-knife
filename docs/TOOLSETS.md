# Tool sets, the welcome wizard and the CV wizard

How the app introduces itself to people who are not computer savvy.

## Writing rules

- Say what a thing does in the words of someone who wants it done: "Make a photo smaller", not "Image export".
- Say it straight. A tool that stands in for a paid product names that product ("Stop paying for Microsoft 365").
- A named comparison must stay true: state the limits (`limits` in the set), never claim full feature parity, never
  imply a connection with the other company. Every page naming a paid product carries `TRADEMARK_NOTE`. A new paid name
  goes in that note too (`tests/toolsets.test.mjs`).
- No jargon outside the tools for developers: no "sidecar", "self-hosted", "endpoint", "deterministic". The technical
  name stays in `keywords`, so search and the assistant still find it.
- Slugs and tab ids never change (they are bookmarks); only names and labels do.

## Tool sets

`src/lib/toolsets.ts` (`TOOL_SETS`, `TOP_TASKS`): one set per real job, with its headline, what it replaces, and the tasks
as people would say them, each linking to a tool or tab. `/sets/<id>` (`src/app/sets/[id]/page.tsx`) is public in both
modes and reads only this data, like a tool's about page. The home page shows `TOP_TASKS`, the sets, then all tools; the
guest page shows the comparison and the sets. `tests/toolsets.test.mjs` checks every link against the registry.

## Welcome wizard

`/welcome` (`src/components/welcome/WelcomeWizard.tsx`): language, what you came for (pinned to Favorites), four facts,
where to start. `needsWelcome` on the account is set only by website sign-up (registration, GitHub), so accounts made
with the CLI and older accounts never see it. `/` redirects there once, and only `/`: a link to a tool is never
interrupted. `PUT /api/account/welcome` clears it, on finishing or skipping. The home page links back to it.

## CV wizard

`src/tools/cv/CvWizard.tsx` + `src/lib/cv/wizard.ts`: an empty CV opens on three ways in. Answering questions is one topic
per screen, only the name is required, dates are accepted as people write them (`normalizeMonth`), and the draft stays in
local storage per account until the CV is created (logging out clears it, `accountStorageKeys`). An uploaded CV needs no
AI: `guessFromCvText` fills in only what is safe (name, email, phone, a profile link) and keeps the text next to the
questions. New accounts have no AI model, so no step of either wizard may depend on one; the AI routes are offered next to
them and say they need a model.
