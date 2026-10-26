import { DEFAULT_LOCALE, translate, translateMessage, translatePlural, type Locale, type Vars } from "./core";

/**
 * The interface language for code that runs only in the browser and outside React: the assistant's runtime (approval
 * cards, step labels, live-tool titles), toasts built in helpers. The I18nProvider sets it on render, in the browser
 * only; never use `ct` for text the server renders (hydration: the server has no such state, use useT/getT there).
 */
let current: Locale = DEFAULT_LOCALE;

export function setClientLocale(locale: Locale): void {
  if (typeof window !== "undefined") current = locale;
}

export function clientLocale(): Locale {
  return current;
}

/** Translate in the browser's current interface language. */
export function ct(text: string, vars?: Vars): string {
  return translate(current, text, vars);
}

export function ctn(one: string, other: string, n: number, vars?: Vars): string {
  return translatePlural(current, one, other, n, vars);
}

/** A server / library message (errors, toasts) in the current interface language: exact text or a known template. */
export function cmsg(message: string): string {
  return translateMessage(current, message);
}
