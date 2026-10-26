import * as z from "zod/v4";
import { guard, json, jsonError, parseBody } from "@/lib/accounts/http";
import { isHttps, resolveAccount } from "@/lib/accounts/session";
import { setAccountLanguage } from "@/lib/accounts/store";
import { LOCALE_COOKIE, LOCALES } from "@/lib/i18n/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ locale: z.enum(LOCALES) }).strict();
const YEAR = 365 * 24 * 60 * 60;

/**
 * POST /api/locale { locale: "en" | "pl" } -> { locale }: the interface language. Sets the `knife_lang` cookie (this device,
 * guests too) and, for a signed-in account, saves it on the account so a new device starts in it (docs/I18N.md).
 */
export async function POST(request: Request): Promise<Response> {
  const blocked = guard(request, true);
  if (blocked) return blocked;
  const parsed = await parseBody(request, bodySchema, '{ locale: "en" | "pl" }', 256);
  if ("response" in parsed) return parsed.response;
  const { locale } = parsed.data;
  const account = resolveAccount(request);
  if (account) {
    try {
      setAccountLanguage(account.id, locale);
    } catch {
      return jsonError("Could not save the language.", 500);
    }
  }
  const response = json({ locale, saved: Boolean(account) });
  const attributes = [`${LOCALE_COOKIE}=${locale}`, "Path=/", "SameSite=Lax", `Max-Age=${YEAR}`];
  if (isHttps(request)) attributes.push("Secure");
  response.headers.append("Set-Cookie", attributes.join("; "));
  return response;
}
