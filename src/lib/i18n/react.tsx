"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_LOCALE, translator, type Locale, type Translator } from "./core";
import { setClientLocale } from "./client-locale";

/**
 * The interface language in client components. The root layout resolves it on the server (cookie, account, browser:
 * server.ts getLocale) and hands it down, so server HTML and hydration agree; switching sets the cookie and refreshes
 * the server tree (switch.ts), which re-renders this provider with the new locale.
 */

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // browser-only runtime text (client-locale.ts) follows the same choice; a no-op on the server
  setClientLocale(locale);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** `const { t, tn, num, date, locale } = useT();` */
export function useT(): Translator {
  return translator(useContext(LocaleContext));
}
