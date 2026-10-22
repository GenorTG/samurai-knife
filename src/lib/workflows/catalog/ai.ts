/**
 * AI nodes (docs/WORKFLOWS.md "AI"): metadata only (implementations: src/lib/workflows/nodes/ai.ts). Every AI node takes
 * its model from one of the account's saved provider profiles (default: the active one) or from an "AI provider"
 * credential (endpoint, key, model typed for this workflow). OpenAI-compatible chat completions with tool calling.
 */
import type { NodeMeta, NodeParam } from "../types";

const MODEL_PARAMS: NodeParam[] = [
  {
    name: "source",
    label: "Model from",
    type: "options",
    default: "profile",
    options: [
      { value: "profile", label: "A saved provider profile", description: "Your account's AI provider profiles (Account settings / the assistant's settings)." },
      { value: "credential", label: "An AI provider credential", description: "Endpoint, key and model saved as a workflow credential." },
    ],
  },
  { name: "profile", label: "Provider profile", type: "providerProfile", default: "", showIf: { source: ["profile"] }, description: "Empty = the profile the assistant uses now." },
  { name: "model", label: "Model (optional override)", type: "string", default: "", placeholder: "the profile's model" },
  { name: "temperature", label: "Temperature", type: "number", default: 0.3, min: 0, max: 2 },
];

const MODEL_CREDENTIAL = [{ name: "provider", label: "AI provider", types: ["aiProvider"], required: true, showIf: { source: ["credential"] } }];

const OUTPUT_FORMAT: NodeParam[] = [
  { name: "outputFormat", label: "Answer as", type: "options", default: "text", options: [{ value: "text", label: "Text" }, { value: "json", label: "JSON (parsed into fields)" }] },
  { name: "jsonExample", label: "JSON shape (example or schema)", type: "json", default: '{\n  "answer": "…"\n}', showIf: { outputFormat: ["json"] }, description: "The model is told to answer with JSON of this shape." },
];

export const AI_NODES: NodeMeta[] = [
  {
    type: "core.ai-agent",
    label: "AI Agent",
    keywords: ["llm", "gpt", "claude", "agent", "tools", "assistant", "chat", "openai", "function calling"],
    group: "ai",
    description: "An AI agent with your instructions that can call tools (HTTP, code, sub-workflows, calculator) until it has the answer.",
    inputs: 1,
    outputs: ["main"],
    params: [
      ...MODEL_PARAMS,
      { name: "instructions", label: "Instructions (system message)", type: "string", rows: 6, default: "You are a helpful assistant. Answer briefly." },
      { name: "prompt", label: "Prompt (per item)", type: "string", rows: 3, default: "={{ $json.chatInput ?? $json.text ?? JSON.stringify($json) }}" },
      {
        name: "tools",
        label: "Tools",
        type: "list",
        default: [],
        fields: [
          {
            name: "kind",
            label: "Tool",
            type: "options",
            default: "httpRequest",
            options: [
              { value: "httpRequest", label: "HTTP request" },
              { value: "code", label: "JavaScript (sandboxed)" },
              { value: "workflow", label: "Call a workflow" },
              { value: "calculator", label: "Calculator" },
              { value: "dateTime", label: "Current date and time" },
            ],
          },
          { name: "name", label: "Name", type: "string", default: "", placeholder: "get_weather", noExpression: true },
          { name: "description", label: "When to use it", type: "string", default: "", noExpression: true, description: "The model reads this to decide when to call the tool." },
          { name: "method", label: "Method", type: "options", default: "GET", options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value })), showIf: { kind: ["httpRequest"] } },
          { name: "url", label: "URL ({name} placeholders are filled by the model)", type: "string", default: "", placeholder: "https://api.example.com/weather?city={city}", noExpression: true, showIf: { kind: ["httpRequest"] } },
          { name: "code", label: "JavaScript (the model's arguments are in `input`; return the answer)", type: "code", language: "javascript", rows: 6, default: "return { echo: input };", noExpression: true, showIf: { kind: ["code"] } },
          { name: "workflowId", label: "Workflow id", type: "string", default: "", noExpression: true, showIf: { kind: ["workflow"] } },
          { name: "inputSchema", label: "Arguments (JSON schema, optional)", type: "json", default: "", noExpression: true, showIf: { kind: ["httpRequest", "code", "workflow"] } },
        ],
      },
      {
        name: "memory",
        label: "Memory",
        type: "options",
        default: "none",
        options: [
          { value: "none", label: "None (each item on its own)" },
          { value: "session", label: "Remember the conversation per session key (kept with the workflow)" },
        ],
      },
      { name: "sessionKey", label: "Session key", type: "string", default: "={{ $json.sessionId ?? 'default' }}", showIf: { memory: ["session"] } },
      { name: "memoryWindow", label: "Messages remembered", type: "number", default: 10, min: 2, max: 100, showIf: { memory: ["session"] } },
      { name: "maxIterations", label: "Max tool rounds", type: "number", default: 8, min: 1, max: 30 },
      ...OUTPUT_FORMAT,
    ],
    credentials: MODEL_CREDENTIAL,
    hue: 300,
  },
  {
    type: "core.ai-chat",
    label: "Ask AI",
    alias: "Basic LLM Chain",
    keywords: ["llm", "gpt", "prompt", "chat", "summarize", "rewrite", "translate", "openai", "claude"],
    group: "ai",
    description: "One prompt to a model per item (summarize, rewrite, translate, draft…); text or JSON back.",
    inputs: 1,
    outputs: ["main"],
    params: [
      ...MODEL_PARAMS,
      { name: "instructions", label: "Instructions (system message)", type: "string", rows: 4, default: "" },
      { name: "prompt", label: "Prompt", type: "string", rows: 4, default: "=Summarize in two sentences:\n{{ $json.text }}" },
      ...OUTPUT_FORMAT,
      { name: "outputField", label: "Put the answer in", type: "string", default: "text", showIf: { outputFormat: ["text"] } },
    ],
    credentials: MODEL_CREDENTIAL,
    hue: 300,
  },
  {
    type: "core.ai-extract",
    label: "Information Extractor",
    keywords: ["extract", "parse", "fields", "structured", "llm", "invoice", "email"],
    group: "ai",
    description: "Pulls the fields you name out of free text (emails, pages, documents) as typed JSON.",
    inputs: 1,
    outputs: ["main"],
    params: [
      ...MODEL_PARAMS,
      { name: "text", label: "Text", type: "string", rows: 3, default: "={{ $json.text }}" },
      {
        name: "attributes",
        label: "Fields",
        type: "list",
        default: [{ name: "name", type: "string", description: "The person's full name", required: true }],
        fields: [
          { name: "name", label: "Name", type: "string", default: "", noExpression: true },
          { name: "type", label: "Type", type: "options", default: "string", options: ["string", "number", "boolean", "date", "array"].map((value) => ({ value, label: value })) },
          { name: "description", label: "What it is", type: "string", default: "", noExpression: true },
          { name: "required", label: "Required", type: "boolean", default: false },
        ],
      },
      { name: "instructions", label: "Extra instructions", type: "string", rows: 2, default: "" },
    ],
    credentials: MODEL_CREDENTIAL,
    hue: 300,
  },
  {
    type: "core.ai-classify",
    label: "Text Classifier",
    keywords: ["classify", "category", "route", "label", "intent", "sentiment", "llm"],
    group: "ai",
    description: "Sorts each item into your categories (one output per category), e.g. support ticket topics or sentiment.",
    inputs: 1,
    outputs: (parameters) => {
      const list = Array.isArray(parameters.categories) ? parameters.categories : [];
      const labels = list.map((entry, index) => {
        const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
        return typeof name === "string" && name.trim() ? name.trim() : `Category ${index + 1}`;
      });
      if (parameters.fallback === "other") labels.push("Other");
      return labels.length ? labels : ["Category 1"];
    },
    params: [
      ...MODEL_PARAMS,
      { name: "text", label: "Text", type: "string", rows: 3, default: "={{ $json.text }}" },
      {
        name: "categories",
        label: "Categories",
        type: "list",
        default: [{ name: "positive", description: "" }, { name: "negative", description: "" }],
        fields: [
          { name: "name", label: "Name", type: "string", default: "", noExpression: true },
          { name: "description", label: "Description", type: "string", default: "", noExpression: true },
        ],
      },
      { name: "multiple", label: "An item may fit several categories", type: "boolean", default: false },
      { name: "fallback", label: "Items that fit none", type: "options", default: "discard", options: [{ value: "discard", label: "Drop them" }, { value: "other", label: "Send to an Other output" }] },
    ],
    credentials: MODEL_CREDENTIAL,
    hue: 300,
  },
];
