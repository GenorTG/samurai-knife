"use client";

/**
 * Shared code field: CodeMirror 6 with line numbers, bracket matching, search, undo history, Tab indentation and
 * syntax colours from the app's theme variables (light and dark both read well). Languages: JavaScript, TypeScript,
 * JSON, HTML, CSS, plain text; optional extra completions (the workflow globals).
 *
 * The assistant can read and fill it like a textarea (src/lib/agent-client/dom-bridge.ts `data-agent-code`): the
 * editable content carries the attribute and answers the `knife:code-read` / `knife:code-fill` events.
 */
import { useEffect, useRef } from "react";
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";

export type CodeLanguage = "javascript" | "typescript" | "json" | "html" | "css" | "text";

/** Events the agent bridge sends to a code field (see dom-bridge.ts). */
export const CODE_READ_EVENT = "knife:code-read";
export const CODE_FILL_EVENT = "knife:code-fill";

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "oklch(from var(--c-accent) l c 300)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "oklch(from var(--c-good) l c h)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: "oklch(from var(--c-warn) l c h)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--c-faint)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "oklch(from var(--c-accent) l c h)" },
  { tag: [tags.tagName, tags.className, tags.labelName], color: "oklch(from var(--c-accent) l c 200)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--c-ink)" },
  { tag: [tags.variableName, tags.special(tags.variableName)], color: "var(--c-ink)" },
  { tag: [tags.bracket, tags.punctuation, tags.operator, tags.angleBracket], color: "var(--c-muted)" },
  { tag: tags.invalid, color: "var(--c-danger)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--c-field)", color: "var(--c-ink)", fontSize: "13px", borderRadius: "0.5rem" },
  "&.cm-focused": { outline: "2px solid color-mix(in oklab, var(--c-accent) 55%, transparent)", outlineOffset: "1px" },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)", caretColor: "var(--c-ink)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "var(--c-raised)", color: "var(--c-faint)", border: "none", borderRight: "1px solid var(--c-line)", borderTopLeftRadius: "0.5rem", borderBottomLeftRadius: "0.5rem" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--c-accent) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--c-accent) 10%, transparent)", color: "var(--c-ink)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--c-accent) 28%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--c-ink)" },
  ".cm-tooltip": { backgroundColor: "var(--c-surface)", color: "var(--c-ink)", border: "1px solid var(--c-line-strong)", borderRadius: "0.5rem" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "color-mix(in oklab, var(--c-accent) 22%, transparent)", color: "var(--c-ink)" },
  ".cm-panels": { backgroundColor: "var(--c-raised)", color: "var(--c-ink)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--c-warn) 30%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--c-accent) 25%, transparent)", outline: "none" },
});

function languageExtensions(language: CodeLanguage, completions: Completion[] | undefined): Extension[] {
  const extra = (lang: typeof javascriptLanguage) =>
    completions?.length
      ? [
          lang.data.of({
            autocomplete: (context: CompletionContext) => {
              const word = context.matchBefore(/[$\w.("']*/);
              if (!word || (word.from === word.to && !context.explicit)) return null;
              return { from: word.from, options: completions, validFor: /^[$\w.("']*$/ };
            },
          }),
        ]
      : [];
  switch (language) {
    case "javascript":
      return [javascript(), ...extra(javascriptLanguage)];
    case "typescript":
      return [javascript({ typescript: true })];
    case "json":
      return [json()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    default:
      return [];
  }
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  label: string;
  minRows?: number;
  /** Fill the parent's height (the parent sets it) instead of growing from `minRows`. */
  fill?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  completions?: Completion[];
}

export default function CodeEditor({ value, onChange, language = "javascript", label, minRows = 8, fill = false, placeholder, readOnly = false, completions }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, completions });
  useEffect(() => {
    latest.current = { value, onChange, completions };
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          ...languageExtensions(language, latest.current.completions),
          autocompletion({ activateOnTyping: true }),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", "data-agent-code": language, ...(readOnly ? { "aria-readonly": "true" } : {}) }),
          ...(placeholder ? [placeholderExt(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          fill
            ? EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { overflow: "auto" } })
            : EditorView.theme({ ".cm-scroller, .cm-content, .cm-gutter": { minHeight: `${Math.max(3, minRows) * 1.5}em` } }),
        ],
      }),
    });
    // The assistant reads and fills the whole document (dom-bridge.ts): one undoable change, like a paste.
    const content = editor.contentDOM;
    const onRead = (event: Event) => {
      (event as CustomEvent<{ value: string | null }>).detail.value = editor.state.doc.toString();
    };
    const onFill = (event: Event) => {
      const detail = (event as CustomEvent<{ value: string; ok?: boolean }>).detail;
      if (readOnly) return;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: detail.value }, userEvent: "input.paste" });
      detail.ok = true;
    };
    content.addEventListener(CODE_READ_EVENT, onRead);
    content.addEventListener(CODE_FILL_EVENT, onFill);
    view.current = editor;
    return () => {
      content.removeEventListener(CODE_READ_EVENT, onRead);
      content.removeEventListener(CODE_FILL_EVENT, onFill);
      editor.destroy();
      view.current = null;
    };
  }, [language, label, minRows, fill, placeholder, readOnly]);

  // A value changed from outside (another field, a reload) replaces the document; typing does not loop back.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} data-code-editor={language} className={fill ? "h-full min-h-0 overflow-hidden rounded-lg border border-line-strong" : "overflow-hidden rounded-lg border border-line-strong"} />;
}
