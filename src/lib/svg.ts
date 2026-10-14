const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker", "title", "desc", "text", "tspan", "use", "symbol"]);
const ALLOWED_ATTRS = new Set(["xmlns", "viewBox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "id", "class", "role", "aria-label", "aria-hidden", "focusable", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "preserveAspectRatio", "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "href"]);
export function sanitizeSvgMarkup(source: string): string {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") throw new Error("Input must be a well-formed SVG document.");
  const visit = (element: Element) => {
    for (const child of [...element.children]) {
      if (!ALLOWED_TAGS.has(child.localName)) { child.remove(); continue; }
      visit(child);
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name;
      const value = attr.value.trim();
      const localHref = name === "href" && value.startsWith("#");
      const safeStyle = name === "style" && !/(?:url\s*\(|expression\s*\(|@import)/i.test(value);
      if (name.toLowerCase().startsWith("on") || (!ALLOWED_ATTRS.has(name) && !safeStyle) || ((name === "href" || name === "xlink:href") && !localHref) || /javascript\s*:/i.test(value)) element.removeAttribute(name);
    }
  };
  visit(doc.documentElement);
  return new XMLSerializer().serializeToString(doc.documentElement);
}
