/**
 * Repository path globs for knife_site_files {glob}: `*` = any characters inside one path segment, `**` = any number of
 * whole segments, `?` = one character, everything else literal; a pattern without `/` matches the file name at any depth. No regex is built from the pattern (user-shaped regex
 * never runs on the server's main thread, docs/ARCHITECTURE.md): matching is a bounded dynamic program.
 */

export const MAX_GLOB_LENGTH = 200;

function matchSegment(pattern: string, text: string): boolean {
  // Classic wildcard DP over one segment: O(pattern * text), both bounded by the path length caps.
  let prev = new Array<boolean>(text.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= pattern.length; i++) {
    const p = pattern[i - 1];
    const next = new Array<boolean>(text.length + 1).fill(false);
    next[0] = p === "*" && prev[0];
    for (let j = 1; j <= text.length; j++) {
      if (p === "*") next[j] = prev[j] || next[j - 1];
      else next[j] = prev[j - 1] && (p === "?" || p === text[j - 1]);
    }
    prev = next;
  }
  return prev[text.length];
}

export function globMatch(pattern: string, path: string): boolean {
  if (!pattern.includes("/")) return matchSegment(pattern, path.slice(path.lastIndexOf("/") + 1));
  const ps = pattern.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const ts = path.split("/").filter(Boolean);
  // reach[j] = the pattern prefix matched so far can end before path segment j.
  let reach = new Array<boolean>(ts.length + 1).fill(false);
  reach[0] = true;
  for (const seg of ps) {
    const next = new Array<boolean>(ts.length + 1).fill(false);
    if (seg === "**") {
      let any = false;
      for (let j = 0; j <= ts.length; j++) {
        any = any || reach[j];
        next[j] = any;
      }
    } else {
      for (let j = 0; j < ts.length; j++) if (reach[j] && matchSegment(seg, ts[j])) next[j + 1] = true;
    }
    reach = next;
  }
  return reach[ts.length];
}
