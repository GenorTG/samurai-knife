"use client";

import { useMemo, useState } from "react";
import { Field, Notice, Panel, TextArea, TextInput } from "@/components/ui";

type Rule = { allow: boolean; path: string; order: number };
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(`^${body.split("*").map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${anchored ? "$" : ".*"}$`);
  return regex.test(path);
}
export default function RobotsEvaluator() {
  const [text, setText] = useState("User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /tmp\n\nUser-agent: Googlebot\nDisallow: /preview/");
  const [agent, setAgent] = useState("*");
  const [path, setPath] = useState("/private/public/page");
  const result = useMemo(() => {
    const groups: { agents: string[]; rules: Rule[] }[] = [];
    let group = { agents: [] as string[], rules: [] as Rule[] };
    let sawRule = false;
    text.split(/\r?\n/).forEach((line, order) => {
      const trimmed = line.split("#")[0].trim();
      if (!trimmed) return;
      const colon = trimmed.indexOf(":");
      if (colon < 0) return;
      const key = trimmed.slice(0, colon).trim().toLowerCase();
      const value = trimmed.slice(colon + 1).trim();
      if (key === "user-agent") {
        if (sawRule && group.agents.length) { groups.push(group); group = { agents: [], rules: [] }; sawRule = false; }
        group.agents.push(value.toLowerCase());
      } else if ((key === "allow" || key === "disallow") && group.agents.length) {
        sawRule = true;
        if (value) group.rules.push({ allow: key === "allow", path: value, order });
      }
    });
    if (group.agents.length) groups.push(group);
    const requested = agent.trim().toLowerCase();
    // RFC 9309: only the most specific user-agent applies (longest matching product token); "*" is the fallback. Groups naming the same agent merge.
    let best = 0;
    for (const item of groups) for (const name of item.agents) if (name && name !== "*" && requested !== "*" && requested.includes(name)) best = Math.max(best, name.length);
    const matching = groups.filter((item) => item.agents.some((name) => (best ? name === "*" ? false : name.length === best && requested.includes(name) : name === "*")));
    const target = path.trim().startsWith("/") || !path.trim() ? path.trim() || "/" : `/${path.trim()}`;
    const rules = matching.flatMap((item) => item.rules).filter((rule) => patternMatches(rule.path, target)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow) || a.order - b.order);
    return { matchedGroups: matching.length, rule: rules[0] ?? null };
  }, [agent, path, text]);
  return <Panel title="robots.txt path evaluator">
    <div className="space-y-3"><Field label="User-agent"><TextInput value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="* or a crawler name" /></Field><Field label="Path to check"><TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="/docs/page" /></Field>
      <Field label="robots.txt"><TextArea rows={12} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      {!result.matchedGroups ? <Notice>No matching user-agent group found. Crawlers with no applicable group may fetch everything.</Notice> : result.rule ? <Notice tone={result.rule.allow ? "good" : "error"}>{result.rule.allow ? "Allowed" : "Disallowed"} by “{result.rule.allow ? "Allow" : "Disallow"}: {result.rule.path}” (longest matching rule wins).</Notice> : <Notice tone="good">Allowed: no matching Allow/Disallow rule. robots.txt is advisory, not access control.</Notice>}
      <p className="text-xs text-faint">Evaluates pasted rules only. Supports wildcard * and terminal $, group-specific and wildcard agents, and longest-rule precedence; it does not fetch robots.txt or implement every crawler-specific extension.</p>
    </div>
  </Panel>;
}
