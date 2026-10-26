/**
 * Marks an interface text defined outside a component (registry names, option lists, module constants) for the
 * catalogue (scripts/i18n-extract.mjs) without translating it yet: it returns the text unchanged. Translate where it is
 * shown, with the locale of that render: `t(tool.name)`. Pure.
 */
export function msg<T extends string>(text: T): T {
  return text;
}

/**
 * A server message with values, kept as a template for the catalogue: `msgf("Needs {needed}, {free} free", { needed, free })`
 * returns the English text filled in (what the API sends); the browser recognises the template and shows it translated
 * (client-locale.ts ct, by pattern). Pure.
 */
export function msgf(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key] ?? "") : whole));
}
