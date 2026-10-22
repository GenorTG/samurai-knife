"use client";

/**
 * The workflow editor's code field (Code node, JSON bodies): CodeMirror 6 with line numbers, bracket matching, search,
 * undo history, Tab indentation and completions for the workflow globals ($json, $input, $("Node"), DateTime…).
 * Colours come from the app's theme variables, so light and dark both read well.
 */
import { useEffect, useRef } from "react";
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";

const GLOBALS: Completion[] = [
  { label: "$json", type: "variable", info: "The current item's data" },
  { label: "$binary", type: "variable", info: "The current item's files (metadata)" },
  { label: "$input.all()", type: "function", info: "Every input item" },
  { label: "$input.first()", type: "function", info: "The first input item" },
  { label: "$input.last()", type: "function", info: "The last input item" },
  { label: "$input.item", type: "variable", info: "The current input item (per-item mode)" },
  { label: '$("Node name").all()', type: "function", info: "Every item another node output" },
  { label: '$("Node name").first()', type: "function", info: "The first item another node output" },
  { label: '$("Node name").item', type: "variable", info: "The matching item of another node" },
  { label: "$itemIndex", type: "variable" },
  { label: "$runIndex", type: "variable" },
  { label: "$now", type: "variable", info: "DateTime of the run's start" },
  { label: "$today", type: "variable", info: "DateTime at the start of today" },
  { label: "$execution.id", type: "variable" },
  { label: "$execution.resumeUrl", type: "variable", info: "Call it to resume a waiting run" },
  { label: "$workflow.name", type: "variable" },
  { label: "$workflow.id", type: "variable" },
  { label: "$vars", type: "variable" },
  { label: "DateTime.now()", type: "function" },
  { label: "DateTime.fromISO()", type: "function" },
  { label: "items", type: "variable", info: "Every input item (run once for all items)" },
  { label: "console.log()", type: "function", info: "Shown under the node's output" },
];

function workflowCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[$\w.("']*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: GLOBALS, validFor: /^[$\w.("']*$/ };
}

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "oklch(from var(--c-accent) l c 300)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "oklch(from var(--c-good) l c h)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "oklch(from var(--c-warn) l c h)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--c-faint)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "oklch(from var(--c-accent) l c h)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--c-ink)" },
  { tag: [tags.variableName, tags.special(tags.variableName)], color: "var(--c-ink)" },
  { tag: [tags.bracket, tags.punctuation, tags.operator], color: "var(--c-muted)" },
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

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: "javascript" | "json" | "text" | "html" | "sql";
  label: string;
  minRows?: number;
  placeholder?: string;
  readOnly?: boolean;
}

export default function CodeEditor({ value, onChange, language = "javascript", label, minRows = 8, placeholder, readOnly = false }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const languageExt: Extension[] =
      language === "javascript" ? [javascript(), javascriptLanguage.data.of({ autocomplete: workflowCompletions })] : language === "json" ? [json()] : [];
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          ...languageExt,
          autocompletion({ activateOnTyping: true }),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
          ...(placeholder ? [placeholderExt(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({ ".cm-scroller, .cm-content, .cm-gutter": { minHeight: `${Math.max(3, minRows) * 1.5}em` } }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [language, label, minRows, placeholder, readOnly]);

  // A value changed from outside (another field, a reload) replaces the document; typing does not loop back.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} data-code-editor={language} className="overflow-hidden rounded-lg border border-line-strong" />;
}
