import { cookies, headers } from "next/headers";
import { isPublicMode } from "@/lib/accounts/mode";
import { sessionAccount } from "@/lib/accounts/viewer";
import { getDefaultAccount } from "@/lib/accounts/store";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, translator, type Locale, type Translator } from "./core";

/**
 * SERVER ONLY. The interface language of this request, in order: the `knife_lang` cookie (what the switcher set on this
 * device), the signed-in account's choice (a new device; private mode: the default account's), the browser's
 * Accept-Language, English.
 */
export async function getLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const account = (await sessionAccount()) ?? (isPublicMode() ? null : safeDefault());
  if (account?.language && isLocale(account.language)) return account.language;
  return localeFromAcceptLanguage((await headers()).get("accept-language")) ?? DEFAULT_LOCALE;
}

function safeDefault() {
  try {
    return getDefaultAccount();
  } catch {
    return null;
  }
}

/** `const { t } = await getT();` in server components and pages. */
export async function getT(): Promise<Translator> {
  return translator(await getLocale());
}

/** For route handlers (no request-scoped cookies() needed): the cookie, else Accept-Language. */
export function requestLocale(request: Request): Locale {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([a-z]{2})`));
  if (match && isLocale(match[1])) return match[1];
  return localeFromAcceptLanguage(request.headers.get("accept-language")) ?? DEFAULT_LOCALE;
}
