import * as z from "zod/v4";
import { getAccount } from "@/lib/accounts/store";
import { CraftFileError, readCraftFile } from "@/lib/craft/files";
import { msg } from "@/lib/i18n/msg";
import { wrapUntrusted } from "@/lib/security/untrusted";
import { SiteError } from "@/lib/site/net";
import { accountDescriber, accountVisionRoute, describeImage, VisionError } from "@/lib/vision/describe";
import { getImage, IMAGE_ID } from "@/lib/vision/images";
import { takeScreenshot, VIEWPORTS } from "@/lib/vision/screenshot";
import { resolveScreenshotTarget } from "@/lib/vision/targets";
import { defineTool, KnifeRichResult, type KnifeToolContext, type KnifeToolDefinition } from "./define";
import { withProjectArg } from "./project-scope";

/**
 * Vision (docs/ACCOUNTS.md "Vision", docs/WEBSITE-STUDIO.md "Screenshots"): let agents SEE the user's website.
 * - knife_site_screenshot: a real browser renders a page of the user's own site (production, the Vercel preview, its
 *   GitHub Pages) and the picture goes to whoever reads it in the form it can use: an MCP client gets an image block;
 *   the in-page assistant's model gets the picture as an image part when its profile sees images (the chat route adds
 *   it, src/lib/vision/inject.ts), else the helper model's text description, else neither (never an image to a
 *   text-only model).
 * - knife_vision_describe: the same helper (or a seeing active model) on an image the account already has.
 */

function account(ctx: KnifeToolContext | undefined): string {
  if (!ctx?.accountId) throw new Error(msg("Vision tools need an account context."));
  return ctx.accountId;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SiteError || error instanceof VisionError || error instanceof CraftFileError) throw new Error(error.message);
    throw error;
  }
}

const NO_VISION_NOTE =
  "No model can see images for this account, so no description was made: in the assistant's settings (Provider), mark the profile as seeing images, or choose a vision helper profile for it. The picture is kept for 30 minutes as imageArtifact.";

/** An image the account can read: a screenshot id (vis_..., this server's memory) or a Craft file id (My files). */
function loadImage(accountId: string, id: string): { mime: string; bytes: Buffer; source: string } {
  if (IMAGE_ID.test(id)) {
    const image = getImage(accountId, id);
    if (!image) throw new VisionError(msg("Unknown or expired image: screenshots are kept for 30 minutes (and not across a server restart). Take a new one."), 404);
    return { mime: image.mime, bytes: image.bytes, source: `screenshot ${image.source}` };
  }
  if (/^[0-9a-f]{20}$/.test(id)) {
    const { file, bytes } = readCraftFile(accountId, id);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.mime)) throw new VisionError(msg("That file is not a PNG, JPEG, GIF or WebP image."), 415);
    if (bytes.byteLength > 8 * 1024 * 1024) throw new VisionError(msg("That image is larger than 8 MB."), 413);
    return { mime: file.mime, bytes, source: `Craft file ${file.name}` };
  }
  throw new VisionError(msg("image must be a screenshot id (vis_...) or a Craft file id (20 hex characters)."));
}

const SCREENSHOT = defineTool({
  name: "knife_site_screenshot",
  scope: "account",
  effect: "outbound",
  urlArgs: ["url"],
  untrustedOutput: true,
  description:
    "Open a project-related page in a real browser and return its screenshot. target production (default: the connected live site or saved website), preview (the READY deployment of the linked Vercel project, including protected previews), or url (only a page on that site, a Vercel deployment confirmed to belong to the linked project, the repository's GitHub Pages, or a page inside the connected public GitHub repository). This is not a general web crawler: unrelated sites are refused. Use production/preview to inspect the live site or work-in-progress; use GitHub API tools for private repository contents. path is relative to the selected site (e.g. /about). viewport desktop (1280x800) or mobile; fullPage captures at most 4000 px. For Vercel dashboard data use knife_site_previews/deploy_logs; dashboard pages are not opened in an unauthenticated browser. Vision: an MCP client receives the image itself (image:false omits it); describe:true or a question (or a vision helper set up by the user) adds a text description. The result's imageArtifact id (kept 30 minutes) works with knife_vision_describe.",
  schema: z.object({
    target: z.enum(["production", "preview", "url"]).default("production"),
    path: z.string().max(300).optional().describe("Page path on the target, e.g. /about (default /)"),
    url: z.string().max(500).optional().describe("Absolute URL, only with target \"url\""),
    viewport: z.enum(["desktop", "mobile"]).default("desktop"),
    fullPage: z.boolean().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    describe: z.boolean().optional().describe("Also return a text description from the user's vision model"),
    question: z.string().max(1_000).optional().describe("A question for the vision model about the screenshot (implies describe)"),
    image: z.boolean().optional().describe("MCP: false = no image block (text-only clients)"),
  }).strict(),
  run(input, ctx) {
    return guarded(async () => {
      const acc = account(ctx);
      const a = getAccount(acc);
      if (!a) throw new VisionError("unknown account", 404);
      const target = await resolveScreenshotTarget(acc, { target: input.target, path: input.path, url: input.url });
      const shot = await takeScreenshot(acc, target, { viewport: input.viewport, fullPage: input.fullPage, format: input.format });
      const base = {
        imageArtifact: shot.image.id,
        target: target.kind,
        url: target.url,
        finalUrl: shot.finalUrl,
        status: shot.status,
        viewport: { name: shot.viewport, ...VIEWPORTS[shot.viewport] },
        image: { mime: shot.image.mime, width: shot.image.width, height: shot.image.height, bytes: shot.image.bytes.byteLength, truncated: shot.truncated },
        page: wrapUntrusted(`web page ${shot.finalUrl}`, JSON.stringify({ title: shot.title })),
        requests: { made: shot.requests, blocked: shot.blockedRequests, refusedByNetworkPolicy: shot.refusedConnections },
      };
      const wantsText = input.describe === true || Boolean(input.question?.trim());
      const describe = async (describer = accountDescriber(a)) => {
        const d = await describeImage(acc, { mime: shot.image.mime, bytes: shot.image.bytes }, input.question, describer ?? undefined);
        return { description: wrapUntrusted(`description of a screenshot of ${shot.finalUrl}`, d.text), describedBy: d.model };
      };

      if (ctx?.surface === "assistant") {
        // The reader is the account's ACTIVE model: a picture only if it sees, else the helper's words, else nothing.
        const route = accountVisionRoute(a);
        if (route.mode === "native") {
          const extra = wantsText ? await describe() : {};
          return { ...base, vision: "native", note: "The screenshot is attached to the conversation as an image right after this result: look at it.", ...extra };
        }
        if (route.mode === "helper") return { ...base, vision: "helper", ...(await describe({ profileId: route.profileId, config: route.config })) };
        return { ...base, vision: "none", note: NO_VISION_NOTE };
      }

      // MCP: the client's own model reads the image block; a description when asked for or when the user set up a helper.
      const describer = accountDescriber(a);
      const helperSet = Boolean(a.provider?.visionHelper && describer && describer.profileId === a.provider.visionHelper);
      let text: Record<string, unknown> = {};
      if (wantsText || helperSet) {
        if (describer) text = await describe(describer);
        else text = { descriptionUnavailable: NO_VISION_NOTE };
      }
      const value = { ...base, ...text };
      if (input.image === false) return value;
      return new KnifeRichResult(value, [{ type: "image", data: shot.image.bytes.toString("base64"), mimeType: shot.image.mime }]);
    });
  },
});

const DESCRIBE = defineTool({
  name: "knife_vision_describe",
  scope: "account",
  effect: "read",
  untrustedOutput: true,
  description:
    "Turn an image into text with the user's vision model (the active provider profile's vision helper, or the active model when it sees images): image = a screenshot id (imageArtifact vis_... from knife_site_screenshot, kept 30 minutes) or a Craft file id (My files, e.g. a saved craft_screenshot). question = what to look for (optional). For agents whose model cannot see images. The description is third-party content.",
  schema: z.object({
    image: z.string().min(1).max(40),
    question: z.string().max(1_000).optional(),
  }).strict(),
  run({ image, question }, ctx) {
    return guarded(async () => {
      const acc = account(ctx);
      const loaded = loadImage(acc, image);
      const d = await describeImage(acc, loaded, question);
      return { image, describedBy: d.model, description: wrapUntrusted(`description of ${loaded.source}`, d.text) };
    });
  },
});

export const VISION_KNIFE_TOOLS: KnifeToolDefinition[] = [...withProjectArg([SCREENSHOT]), DESCRIBE];
