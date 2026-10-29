/**
 * What changed for the assistant and outside agents, newest first (docs/MCP.md "What's new"). Pure data, imported by
 * the browser (the assistant's system prompt) and the server (`knife_whats_new`). One entry per release that changes
 * what an agent can do or how; each item names the tools so a model can answer "do you have new tools?" truthfully.
 * Add the entry in the same commit as the change; `version` is MAJOR.MINOR.PATCH (the BUILD part is not known yet).
 */
export interface WhatsNewEntry {
  version: string;
  date: string;
  items: string[];
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    version: "0.13.0",
    date: "2026-10-28",
    items: [
      "Vision detection: when GET /models does not say whether a model takes images, Provider settings can ask it (Detect, or \"Check all models for vision\": one tiny generated test picture per model); definite answers are remembered per provider address and model for 30 days and shown as \"detected\" in the model list, and picking a model that sees images sets \"Sees images\". Not an agent tool: the user runs it in the assistant's settings.",
      "knife_vision_describe and describe:true give a reasoning vision model room to think (8,000 completion tokens, one retry with 16,000 when it stopped before writing); if it still writes nothing the error says so, and a non-reasoning vision helper profile is the fix. The vision probe likewise retries a cut-off answer and never calls a model text-only because it ran out of tokens.",
      "Anthropic works as a provider (preset api.anthropic.com/v1): Test and Load models read Anthropic's own model list (display names, context window, image input), and chat rounds go through its OpenAI-compatible endpoint without temperature (newer Claude models refuse it).",
      "MCP: every account has its own address, /api/mcp/u/<username>, that needs only Authorization: Bearer <key> (the key must belong to that account); /account shows it with ready-made OpenClaw, Claude Code and Cursor settings. Keys can be read-only: such a client sees and can call only tools marked readOnlyHint. The old /api/mcp keeps working; KNIFE_MCP_REQUIRE_KEY=1 makes a private server refuse MCP calls without a key.",
      "Turn limit: the user sets how many model rounds (4-100, default 24) and tool calls (4-200, default 40) one message may take (Settings > Turn limit); when either runs out, the assistant stops and summarises what is done and what is left, so suggest raising it for long jobs.",
      "Vision: knife_site_screenshot renders a page of the user's own website (production, the Vercel preview of the work branch, its GitHub Pages; desktop or mobile, full page) in a real browser on the server; MCP clients get the image, and a text description from the user's vision model with describe:true or a question. knife_vision_describe turns a screenshot id or a Craft file id into text for models that cannot see. Provider profiles say whether the model sees images and may name a vision helper profile; the in-page assistant sends images only to a model that sees them, otherwise the helper's description.",
      "Provider model discovery now displays context length, image support, and provider-advertised features from GET /models; unknown fields stay unknown, with no model-name guessing. Website screenshots can also open pages under the linked GitHub repository; Vercel deployments are checked against the linked project and this is not a general web crawler.",
      "Website + Vercel (optional, Website tab of cv-studio): knife_site_previews (Vercel previews of the work branch, the deployment of its head commit with state, URL and error), knife_site_deploy_logs (build log of a failed preview), knife_site_deploy (start a PREVIEW build of the work branch; never production). knife_site_audit {target:\"preview\"} and knife_site_page read previews behind Vercel Deployment Protection with the stored bypass secret.",
      "knife_whats_new: this list (the server's version and recent changes for agents).",
      "The assistant now knows its own version and these notes, and says so when its browser tab is older than the server (reload to get new tools).",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-10-28",
    items: [
      "Website studio: Publish is refused while GitHub checks fail or still run; knife_site_changes reports checks and the preview for the exact head commit, and agents must report that evidence (passed, failed, pending, not configured).",
      "CV studio: several CV projects (knife_cv_project_list / _create / _switch, every knife_cv_* and knife_site_* tool takes projectId), 14 layouts, PDF/DOCX/HTML/TXT export, showcase pages, CV upload; the website is the Website tab of cv-studio.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-10-26",
    items: [
      "Workflows: service nodes for GitHub, GitLab, Slack, Discord, Notion, Airtable, Google Sheets/Drive/Calendar, Outlook, Teams and HubSpot (knife_workflow_nodes lists them with their parameters).",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-10-26",
    items: ["The whole interface in Polish and English (global language switch); the assistant answers in the user's language."],
  },
];

/** The newest `count` entries as short lines for a system prompt. */
export function whatsNewLines(count = 3): string {
  return WHATS_NEW.slice(0, count)
    .map((e) => `v${e.version} (${e.date}):\n${e.items.map((i) => `  - ${i}`).join("\n")}`)
    .join("\n");
}
