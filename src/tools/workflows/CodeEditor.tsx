"use client";

/**
 * The workflow editor's code field (Code node, JSON bodies): the shared CodeMirror field (src/components/CodeEditor.tsx)
 * with completions for the workflow globals ($json, $input, $("Node"), DateTime…).
 */
import type { Completion } from "@codemirror/autocomplete";
import SharedCodeEditor, { type CodeEditorProps } from "@/components/CodeEditor";

const GLOBALS: Completion[] = [
  { label: "$json", type: "variable", info: "The current item's data" },
  { label: "$binary", type: "variable", info: "The current item's files (metadata)" },
  { label: "$input.all()", type: "function", info: "Every input item" },
  { label: "$input.first()", type: "function", info: "The first input item" },
  { label: "$input.last()", type: "function", info: "The last input item" },
  { label: "$input.item", type: "variable", info: "The current input item (per-item mode)" },
  { label: "$(\"Node name\").all()", type: "function", info: "Every item another node output" },
  { label: "$(\"Node name\").first()", type: "function", info: "The first item another node output" },
  { label: "$(\"Node name\").item", type: "variable", info: "The matching item of another node" },
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

export default function CodeEditor(props: Omit<CodeEditorProps, "completions">) {
  return <SharedCodeEditor {...props} completions={props.language === "javascript" || props.language === undefined ? GLOBALS : undefined} />;
}
