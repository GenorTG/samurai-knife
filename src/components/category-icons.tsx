import type { ToolCategory } from "@/lib/registry";

const PATHS: Record<ToolCategory, string> = {
  images:
    "M4 5h16v14H4zM4 16l4.5-4.5 3.5 3.5 3-3 5 5M15.5 9.5h.01",
  documents: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  data: "M4 6c0-1.1 3.6-2 8-2s8 .9 8 2-3.6 2-8 2-8-.9-8-2zM4 6v6c0 1.1 3.6 2 8 2s8-.9 8-2V6M4 12v6c0 1.1 3.6 2 8 2s8-.9 8-2v-6",
  text: "M5 6h14M5 11h14M5 16h9",
  dev: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  sidecars: "M4 7h11v10H4zM15 10h3l2 2v5h-5M7 17v2M12 17v2M17.5 17v2M7 10h5",
};

/** Hue per category, applied to the shared accent so it follows the theme. */
const HUES: Record<ToolCategory, number> = {
  images: 200,
  documents: 25,
  data: 155,
  text: 80,
  dev: 290,
  sidecars: 240,
};

export function categoryTint(category: ToolCategory): React.CSSProperties {
  return { color: `oklch(from var(--c-accent) l c ${HUES[category]})` };
}

export function CategoryIcon({
  category,
  size = 20,
}: {
  category: ToolCategory;
  size?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[category]} />
    </svg>
  );
}

export function CategoryTile({
  category,
  size = "md",
}: {
  category: ToolCategory;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "size-7 rounded-lg" : "size-10 rounded-xl";
  return (
    <span
      style={categoryTint(category)}
      className={`inline-flex shrink-0 items-center justify-center bg-current/12 ring-1 ring-current/25 ${box}`}
    >
      <CategoryIcon category={category} size={size === "sm" ? 16 : 20} />
    </span>
  );
}
