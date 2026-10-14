export function parseHtmlFragment(source: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = source;
  return template.content;
}

function accessibleName(el: Element, root: DocumentFragment): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby")?.trim();
  if (labelledBy) return labelledBy.split(/\s+/).map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? "").join(" ").trim();
  const id = el.getAttribute("id");
  const label = id ? [...root.querySelectorAll("label[for]")].find((item) => item.getAttribute("for") === id)?.textContent?.trim() : "";
  return label || el.closest("label")?.textContent?.trim() || "";
}

export function auditHeadings(source: string) {
  const root = parseHtmlFragment(source);
  const headings = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((el) => ({ level: Number(el.tagName.slice(1)), text: el.textContent?.trim() || "(empty heading)" }));
  const issues: string[] = [];
  if (!headings.length) issues.push("No headings found.");
  if (headings.filter((item) => item.level === 1).length > 1) issues.push("More than one H1 heading was found.");
  headings.forEach((heading, index) => { const previous = headings[index - 1]; if (previous && heading.level > previous.level + 1) issues.push(`Heading level jumps from H${previous.level} to H${heading.level}: ${heading.text}`); });
  return { headings, issues };
}

export function auditLinks(source: string) {
  const root = parseHtmlFragment(source);
  const generic = new Set(["click here", "here", "read more", "learn more", "more", "link"]);
  return [...root.querySelectorAll("a")].map((el, index) => {
    const name = accessibleName(el, root) || [...el.querySelectorAll("img[alt]")].map((image) => image.getAttribute("alt")?.trim()).filter(Boolean).join(" ") || el.textContent?.trim() || "";
    return { index: index + 1, href: el.getAttribute("href") ?? "(missing href)", name: name || "(empty)", issue: !name ? "No accessible link name" : generic.has(name.toLowerCase()) ? "Generic link text" : "" };
  });
}

export function auditFormLabels(source: string) {
  const root = parseHtmlFragment(source);
  return [...root.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea,[role=textbox],[role=combobox]")].map((el, index) => {
    const name = accessibleName(el, root);
    return { index: index + 1, control: el.tagName.toLowerCase(), type: el.getAttribute("type") ?? "", id: el.getAttribute("id") ?? "", issue: name ? "" : "Missing associated label / accessible name" };
  });
}

export function auditLandmarks(source: string) {
  const root = parseHtmlFragment(source);
  const selectors: [string, string][] = [
    ["main", "main:not([role]),[role='main']"],
    ["navigation", "nav:not([role]),[role='navigation']"],
    ["banner", "header:not([role]),[role='banner']"],
    ["contentinfo", "footer:not([role]),[role='contentinfo']"],
    ["complementary", "aside:not([role]),[role='complementary']"],
    ["search", "[role='search']"],
    ["region", "[role='region']"],
  ];
  const counts = selectors.map(([role, selector]) => ({ role, count: root.querySelectorAll(selector).length }));
  const issues: string[] = [];
  const main = counts.find((item) => item.role === "main")?.count ?? 0;
  if (!main) issues.push("No main landmark found.");
  if (main > 1) issues.push("Multiple main landmarks found.");
  return { counts, issues };
}
