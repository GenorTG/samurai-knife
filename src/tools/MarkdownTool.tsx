"use client";

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { Button, CopyButton, Field, KeyValues, OutputBlock, Panel, Stat, StatGrid, TextArea } from "@/components/ui";
import { cx, plural } from "@/lib/format";
import { downloadText } from "@/lib/format";
import { countLinksAndImages } from "@/lib/markdown-counts";

/**
 * Markdown bench. Preview is sanitised through DOMPurify before it touches the
 * DOM — the input is treated as hostile, which is the point of a preview.
 * The HTML→Markdown direction is a hand-rolled DOM walk, so it stays readable
 * instead of dumping tags.
 */

const PREVIEW_CLASS = cx(
  "text-sm leading-relaxed text-ink space-y-2",
  "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:pt-1",
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:pt-2 [&_h2]:border-b [&_h2]:border-line",
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:pt-1",
  "[&_a]:text-accent-soft [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-raised [&_code]:px-1 [&_code]:rounded",
  "[&_pre]:rounded-tool [&_pre]:border [&_pre]:border-line [&_pre]:bg-field [&_pre]:p-3 [&_pre]:overflow-auto [&_pre]:text-[12px]",
  "[&_pre_code]:bg-transparent [&_pre_code]:px-0",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-accent [&_blockquote]:pl-3 [&_blockquote]:text-muted",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_th]:text-left",
  "[&_img]:max-w-full [&_hr]:border-line [&_hr]:my-3",
);

const SAMPLE = `# Samurai notes

Two things this preview does:

1. **Sanitise** — script tags and \`onerror\` handlers never reach the DOM.
2. **Count** — headings, links, images and fences are tallied live.

> Everything stays in the browser.

\`\`\`ts
const knife = "swiss army";
\`\`\`

[registry](/tools/regex)
`;

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").trim();
}

/** Minimal, readable HTML → Markdown. Walks the DOM; unknown tags fall through. */
function htmlToMarkdown(source: string): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  const body = doc.body;
  body.querySelectorAll("script,style,meta,link").forEach((node) => node.remove());

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as HTMLElement;
    const kids = () => [...el.childNodes].map(inline).join("");
    switch (el.tagName) {
      case "BR":
        return "  \n";
      case "STRONG":
      case "B":
        return `**${kids().trim()}**`;
      case "EM":
      case "I":
        return `*${kids().trim()}*`;
      case "CODE":
        return `\`${el.textContent ?? ""}\``;
      case "DEL":
      case "S":
        return `~~${kids().trim()}~~`;
      case "A":
        return `[${kids().trim()}](${el.getAttribute("href") ?? ""})`;
      case "IMG":
        return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      case "SPAN":
      case "FONT":
        return kids();
      default:
        return kids();
    }
  };

  const block = (el: Element, depth = 0): string => {
    switch (el.tagName) {
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6": {
        const level = Number(el.tagName[1]);
        return `${"#".repeat(level)} ${inline(el).trim()}\n\n`;
      }
      case "P": {
        const text = inline(el).trim();
        return text ? `${text}\n\n` : "";
      }
      case "BR":
        return "\n";
      case "HR":
        return "---\n\n";
      case "BLOCKQUOTE": {
        const inner = [...el.childNodes]
          .filter((n): n is Element => n.nodeType === Node.ELEMENT_NODE)
          .map((n) => block(n, depth))
          .join("")
          .trim();
        return `${inner.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
      }
      case "PRE": {
        const code = el.querySelector("code");
        const lang = /language-([\w-]+)/.exec(code?.className ?? el.className)?.[1] ?? "";
        return `\`\`\`${lang}\n${(code ?? el).textContent ?? ""}\n\`\`\`\n\n`;
      }
      case "UL":
      case "OL": {
        const ordered = el.tagName === "OL";
        const items = [...el.children].filter((li) => li.tagName === "LI");
        const pad = "  ".repeat(depth);
        return `${items
          .map((li, index) => {
            const marker = ordered ? `${index + 1}. ` : "- ";
            const nested = [...li.children].filter((n) => n.tagName === "UL" || n.tagName === "OL");
            const text = [...li.childNodes]
              .filter((n) => !nested.includes(n as Element))
              .map(inline)
              .join("")
              .trim();
            const tail = nested.map((n) => block(n, depth + 1)).join("");
            return `${pad}${marker}${text}${tail ? `\n${tail.replace(/\n+$/, "")}` : ""}`;
          })
          .join("\n")}\n\n`;
      }
      case "TABLE": {
        const rows = [...el.querySelectorAll("tr")];
        if (!rows.length) return "";
        const cells = rows.map((row) => [...row.children].map((cell) => escapeCell(inline(cell))));
        const widths = cells.map((row) => row.length);
        const columns = Math.max(...widths);
        const header = cells[0] ?? [];
        const lines = [
          `| ${[...header, ...Array(columns - header.length).fill("")].join(" | ")} |`,
          `| ${Array(columns).fill("---").join(" | ")} |`,
          ...cells.slice(1).map((row) => `| ${[...row, ...Array(columns - row.length).fill("")].join(" | ")} |`),
        ];
        return `${lines.join("\n")}\n\n`;
      }
      case "DIV":
      case "SECTION":
      case "ARTICLE":
      case "MAIN":
      case "BODY": {
        const hasBlockChild = [...el.children].some((child) =>
          /^(P|UL|OL|TABLE|PRE|BLOCKQUOTE|H[1-6]|DIV|SECTION|ARTICLE|HR)$/.test(child.tagName),
        );
        if (!hasBlockChild) {
          const text = inline(el).trim();
          return text ? `${text}\n\n` : "";
        }
        return [...el.children].map((child) => block(child, depth)).join("");
      }
      default: {
        const text = inline(el).trim();
        return text ? `${text}\n\n` : "";
      }
    }
  };

  return [...body.childNodes]
    .map((node) =>
      node.nodeType === Node.ELEMENT_NODE
        ? block(node as HTMLElement)
        : (node.textContent ?? "").trim()
          ? `${(node.textContent ?? "").trim()}\n\n`
          : "",
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function MarkdownTool() {
  const [markdown, setMarkdown] = useState(SAMPLE);
  const [htmlInput, setHtmlInput] = useState("<h1>Imported</h1>\n<p>Some <strong>rich</strong> text with a <a href=\"https://example.com\">link</a>.</p>\n<ul><li>one</li><li>two</li></ul>");
  const [showHtml, setShowHtml] = useState(false);

  const [rendered, setRendered] = useState("");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const raw = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
      setRendered(DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } }));
    });
    return () => cancelAnimationFrame(frame);
  }, [markdown]);

  const counts = useMemo(() => {
    const fences = markdown.match(/^```/gm)?.length ?? 0;
    return {
      words: markdown.trim() ? markdown.trim().split(/\s+/).length : 0,
      chars: markdown.length,
      lines: markdown.split("\n").length,
      headings: markdown.match(/^#{1,6}\s/gm)?.length ?? 0,
      ...countLinksAndImages(markdown),
      fences: Math.floor(fences / 2),
      minutes: Math.max(1, Math.round((markdown.trim().split(/\s+/).length || 0) / 220)),
    };
  }, [markdown]);

  const [htmlToMd, setHtmlToMd] = useState("");
  useEffect(() => {
    const frame = requestAnimationFrame(() => setHtmlToMd(htmlToMarkdown(htmlInput)));
    return () => cancelAnimationFrame(frame);
  }, [htmlInput]);

  const structure = useMemo(() => {
    const headings = [...markdown.matchAll(/^(#{1,6})\s+(.*)$/gm)].map(
      ([, hashes, title]) => `${"  ".repeat(hashes.length - 1)}${title.trim()}`,
    );
    return headings.length ? headings : [];
  }, [markdown]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel
          title="Markdown"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setMarkdown(SAMPLE)}>
                Sample
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMarkdown("")}>
                Clear
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <TextArea
              value={markdown}
              spellCheck={false}
              onChange={(e) => setMarkdown(e.target.value)}
              placeholder="# Start typing…"
            />
            <StatGrid>
              <Stat label="Words" value={counts.words} />
              <Stat label="Lines" value={counts.lines} />
              <Stat label="Headings" value={counts.headings} />
              <Stat label="Read time" value={`${counts.minutes} min`} />
              <Stat label="Links" value={counts.links} />
              <Stat label="Images" value={counts.images} />
              <Stat label="Code blocks" value={counts.fences} />
              <Stat label="Chars" value={counts.chars} />
            </StatGrid>
            <p className="text-xs text-faint">
              {plural(counts.headings, "heading")} in this document — the outline is on the right.
            </p>
          </div>
        </Panel>

        <Panel
          title="Preview"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="subtle" onClick={() => setShowHtml((v) => !v)}>
                {showHtml ? "Rendered" : "HTML"}
              </Button>
              <CopyButton text={showHtml ? rendered : markdown} />
              <Button
                size="sm"
                variant="subtle"
                disabled={!markdown}
                onClick={() => downloadText(markdown, "notes.md")}
              >
                Save .md
              </Button>
            </div>
          }
        >
          {showHtml ? (
            <OutputBlock value={rendered} rows={22} empty="Nothing rendered." />
          ) : (
            <div
              className={cx("rounded-tool border border-line bg-surface p-4 min-h-64 max-h-[32rem] overflow-auto", PREVIEW_CLASS)}
              // Sanitised through DOMPurify above; the input is never trusted.
              dangerouslySetInnerHTML={{ __html: rendered }}
            />
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Panel title="Outline">
          {structure.length ? (
            <KeyValues rows={structure.map((title, index) => [String(index + 1), title])} />
          ) : (
            <p className="text-sm text-faint">No headings yet — add a <code>#</code> line.</p>
          )}
        </Panel>

        <Panel
          title="HTML → Markdown"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={htmlToMd} label="Copy markdown" />
              <Button
                size="sm"
                variant="subtle"
                disabled={!htmlToMd}
                onClick={() => downloadText(htmlToMd, "converted.md")}
              >
                Save .md
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Field label="Paste markup" hint="Parsed with DOMParser — scripts are stripped before conversion.">
              <TextArea
                value={htmlInput}
                spellCheck={false}
                onChange={(e) => setHtmlInput(e.target.value)}
                placeholder="<h1>…</h1>"
              />
            </Field>
            <OutputBlock value={htmlToMd} rows={16} empty="Paste markup above." />
          </div>
        </Panel>
      </div>
    </div>
  );
}
