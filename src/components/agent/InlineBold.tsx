import type { ReactNode } from "react";

const BOLD = /\*\*([^*\n]+?)\*\*/g;

/** Renders `**bold**` spans as <strong>; everything else stays literal text (no HTML, no other markdown). */
export function InlineBold({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(BOLD)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <strong key={at} className="font-semibold">
        {match[1]}
      </strong>,
    );
    last = at + match[0].length;
  }
  if (last === 0) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
