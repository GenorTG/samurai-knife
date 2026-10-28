import type { ProviderConfig, ProviderProfile } from "@/lib/accounts/store";
import { msg } from "@/lib/i18n/msg";

/**
 * Vision per provider profile (docs/ACCOUNTS.md "Vision"). Two settings on every profile's config:
 * - `vision`: `native` = the model accepts image parts (OpenAI-compatible `image_url`), so pictures go to it as pictures;
 *   `none` (or unset: every profile saved before this existed) = text-only, an image never goes to it.
 * - `visionHelper`: another saved profile (any OpenAI-compatible vision model) that turns an image into a text
 *   description for this profile when it cannot see.
 * Pure functions only: the assistant's chat route, the tools and the tests share them.
 */

export type VisionMode = "native" | "none";

export type VisionRoute =
  /** The active model sees images itself. */
  | { mode: "native" }
  /** A helper profile describes the image; the active model gets text. */
  | { mode: "helper"; profileId: string; config: ProviderConfig }
  /** No vision at all: no image and no description (the result says how to set one up). */
  | { mode: "none" };

export function visionModeOf(config: Pick<ProviderConfig, "vision"> | null | undefined): VisionMode {
  return config?.vision === "native" ? "native" : "none";
}

/** A helper must be another saved profile; a missing or self-referencing one counts as none. */
function helperProfile(active: ProviderConfig, profiles: readonly ProviderProfile[], activeId: string | null): ProviderProfile | null {
  const id = active.visionHelper;
  if (!id || id === activeId) return null;
  return profiles.find((profile) => profile.id === id) ?? null;
}

/** How images reach the ACTIVE model (the in-page assistant): natively, through the helper, or not at all. */
export function visionRoute(active: ProviderConfig | null | undefined, profiles: readonly ProviderProfile[], activeId: string | null = null): VisionRoute {
  if (!active) return { mode: "none" };
  if (visionModeOf(active) === "native") return { mode: "native" };
  const helper = helperProfile(active, profiles, activeId);
  return helper ? { mode: "helper", profileId: helper.id, config: helper.config } : { mode: "none" };
}

/**
 * Who writes a text description on request (knife_vision_describe, `describe: true`): the active profile's helper when
 * one is set (it was chosen for this), else the active model itself when it sees images, else nobody.
 */
export function describerFor(active: ProviderConfig | null | undefined, profiles: readonly ProviderProfile[], activeId: string | null = null): { profileId: string | null; config: ProviderConfig } | null {
  if (!active) return null;
  const helper = helperProfile(active, profiles, activeId);
  if (helper) return { profileId: helper.id, config: helper.config };
  return visionModeOf(active) === "native" ? { profileId: activeId, config: active } : null;
}

/** Problem with a helper id for a profile being saved, or null. `selfId` = the profile being edited (absent on create). */
export function visionHelperProblem(helperId: string | undefined, profiles: readonly Pick<ProviderProfile, "id">[], selfId?: string): string | null {
  if (!helperId) return null;
  if (selfId && helperId === selfId) return msg("A profile cannot be its own vision helper.");
  if (!profiles.some((profile) => profile.id === helperId)) return msg("The vision helper is not a saved profile.");
  return null;
}
