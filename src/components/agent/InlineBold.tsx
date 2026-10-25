import type { ReactNode } from "react";

/**
 * The small markdown subset models use in chat replies, rendered without HTML: `**bold**`, `` `code` ``, http(s) links
 * (new tab, no referrer) and "- " / "* " list lines as bullets. Everything else stays literal text (the transcript
 * keeps `white-space: pre-wrap`, so line breaks and indentation survive).
 */
const TOKEN = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
const BULLET = /^(\s*)[-*] (?=\S)/gm;

export function InlineBold({ text }: { text: string }) {
  const source = text.replace(BULLET, "$1• ");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(source.slice(last, at));
    if (match[1] !== undefined) {
      parts.push(
        <strong key={at} className="font-semibold">
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      parts.push(
        <code key={at} className="rounded bg-raised px-1 py-px font-mono text-[0.92em]">
          {match[2]}
        </code>,
      );
    } else {
      parts.push(
        <a key={at} href={match[3]} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2 hover:opacity-80">
          {match[3]}
        </a>,
      );
    }
    last = at + match[0].length;
  }
  if (last === 0) return <>{source}</>;
  if (last < source.length) parts.push(source.slice(last));
  return <>{parts}</>;
}
