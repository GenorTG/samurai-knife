"use client";

import { Field, Select, TextInput } from "@/components/ui";
import * as chroma from "@/lib/nosql/chroma";
import { FormGroup, JsonField, NosqlWorkbench, isRecord, orderKeys, parseJsonSpec, specToText, type StoreAdapter } from "./nosql-workbench";

const adapter: StoreAdapter = {
  id: "chroma",
  name: "Chroma",
  noun: "Chroma operation",
  tools: { compile: "knife_chroma_compile", validate: "knife_chroma_validate" },
  parse: parseJsonSpec,
  compile: chroma.compile,
  validate: chroma.validate,
  explain: chroma.explain,
  examples: chroma.CHROMA_EXAMPLES,
};

interface FieldDef {
  key: string;
  label: string;
  hint: string;
  rows?: number;
}

const IDS: FieldDef = { key: "ids", label: "ids (JSON list)", hint: 'Unique string ids. Example: ["id1", "id2"]', rows: 2 };
const RECORDS: FieldDef[] = [
  IDS,
  { key: "documents", label: "documents (JSON list)", hint: 'The texts to store. Chroma embeds them unless you give embeddings. Example: ["first text", "second text"]', rows: 3 },
  { key: "embeddings", label: "embeddings (JSON list of lists)", hint: "Optional vectors, one per id, all the same length. Example: [[0.1, 0.2], [0.3, 0.4]]", rows: 2 },
  { key: "metadatas", label: "metadatas (JSON list of objects)", hint: 'Optional, one per id; values are strings, numbers, booleans or arrays of one type. Example: [{"topic": "cats", "year": 2024}]', rows: 3 },
];
const WHERE: FieldDef = { key: "where", label: "where (JSON, metadata filter)", hint: 'One condition per object; combine with $and/$or. Example: {"$and": [{"year": {"$gte": 2023}}, {"topic": "dogs"}]}', rows: 3 };
const WHERE_DOC: FieldDef = { key: "where_document", label: "where_document (JSON, text filter)", hint: 'Example: {"$contains": "search words"}', rows: 2 };
const INCLUDE: FieldDef = { key: "include", label: "include (JSON list)", hint: 'What to return besides ids. Example: ["documents", "metadatas", "distances"]', rows: 2 };

const FIELD_DEFS: Record<chroma.ChromaOp, FieldDef[]> = {
  create_collection: [{ key: "metadata", label: "Collection metadata (JSON)", hint: 'Optional. Example: {"description": "my notes"}', rows: 2 }, { key: "configuration", label: "configuration (JSON)", hint: 'Optional. Distance: {"hnsw": {"space": "cosine"}} (l2, cosine or ip)', rows: 2 }],
  get_or_create_collection: [{ key: "metadata", label: "Collection metadata (JSON)", hint: 'Optional. Example: {"description": "my notes"}', rows: 2 }, { key: "configuration", label: "configuration (JSON)", hint: 'Optional. Distance: {"hnsw": {"space": "cosine"}} (l2, cosine or ip)', rows: 2 }],
  add: RECORDS,
  upsert: RECORDS,
  update: RECORDS,
  get: [{ ...IDS, label: "ids (JSON list, optional)" }, WHERE, WHERE_DOC, INCLUDE],
  query: [
    { key: "query_texts", label: "query_texts (JSON list)", hint: 'Texts to search for (embedded with the collection\'s embedding function). Example: ["pets that sleep"]', rows: 2 },
    { key: "query_embeddings", label: "query_embeddings (JSON list of lists)", hint: "Use instead of query_texts when you have your own vectors.", rows: 2 },
    WHERE,
    WHERE_DOC,
    INCLUDE,
  ],
  delete: [{ ...IDS, label: "ids (JSON list, optional)" }, WHERE, WHERE_DOC],
  count: [],
};
const KEY_ORDER = ["op", "client", "collection", "metadata", "configuration", "embedding_function", "ids", "documents", "embeddings", "metadatas", "query_texts", "query_embeddings", "n_results", "where", "where_document", "limit", "offset", "include"];
const DEFAULTS: Record<chroma.ChromaOp, Record<string, unknown>> = {
  create_collection: {},
  get_or_create_collection: {},
  add: { ids: ["id1"], documents: ["some text"] },
  upsert: { ids: ["id1"], documents: ["some text"] },
  update: { ids: ["id1"], metadatas: [{ key: "value" }] },
  get: { limit: 10 },
  query: { query_texts: ["some text"], n_results: 5 },
  delete: { ids: ["id1"] },
  count: {},
};
const OP_LABEL: Record<chroma.ChromaOp, string> = {
  create_collection: "create_collection: new collection (errors if it exists)",
  get_or_create_collection: "get_or_create_collection: open or create",
  add: "add: insert records",
  upsert: "upsert: insert or overwrite records",
  update: "update: change existing records",
  get: "get: fetch records (no similarity)",
  query: "query: find nearest records",
  delete: "delete: remove records",
  count: "count: number of records",
};

function ChromaForm({ spec, setSpec }: { spec: Record<string, unknown>; setSpec: (spec: Record<string, unknown>) => void }) {
  const op = (chroma.CHROMA_OPS as readonly string[]).includes(String(spec.op)) ? (spec.op as chroma.ChromaOp) : "query";
  const write = (patch: Record<string, unknown>) => setSpec(orderKeys({ ...spec, ...patch }, KEY_ORDER));
  const changeOp = (next: chroma.ChromaOp) => {
    const allowed = new Set(chroma.CHROMA_FIELDS[next]);
    const kept = Object.fromEntries(Object.entries(spec).filter(([key]) => allowed.has(key)));
    setSpec(orderKeys({ ...DEFAULTS[next], ...kept, op: next }, KEY_ORDER));
  };
  const client = isRecord(spec.client) ? spec.client : {};
  const clientType = typeof client.type === "string" ? client.type : "persistent";
  const writeClient = (patch: Record<string, unknown>) => {
    const next = Object.fromEntries(Object.entries({ ...client, ...patch }).filter(([, value]) => value !== undefined && value !== ""));
    write({ client: Object.keys(next).length ? next : undefined });
  };
  const numberField = (key: "n_results" | "limit" | "offset", label: string, hint: string, min: number) => (
    <Field label={label} hint={hint}>
      <TextInput type="number" min={min} inputMode="numeric" value={typeof spec[key] === "number" ? String(spec[key]) : ""} onChange={(event) => write({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })} />
    </Field>
  );
  const isCreate = op === "create_collection" || op === "get_or_create_collection";
  return (
    <>
      <Field label="Operation">
        <Select value={op} onChange={(event) => changeOp(event.target.value as chroma.ChromaOp)}>
          {chroma.CHROMA_OPS.map((name) => (
            <option key={name} value={name}>
              {OP_LABEL[name]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Collection" hint="3-512 characters: letters, digits, dots, dashes, underscores; start and end with a letter or digit.">
        <TextInput value={typeof spec.collection === "string" ? spec.collection : ""} onChange={(event) => write({ collection: event.target.value })} placeholder="articles" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Client">
          <Select value={clientType} onChange={(event) => writeClient({ type: event.target.value === "persistent" ? undefined : event.target.value, path: undefined, host: undefined, port: undefined, ssl: undefined, tenant: undefined, database: undefined })}>
            <option value="persistent">PersistentClient (local folder)</option>
            <option value="http">HttpClient (Chroma server)</option>
            <option value="cloud">CloudClient (Chroma Cloud)</option>
            <option value="ephemeral">Client (in memory)</option>
          </Select>
        </Field>
        {clientType === "persistent" ? (
          <Field label="Data folder (path)">
            <TextInput value={typeof client.path === "string" ? client.path : ""} onChange={(event) => writeClient({ path: event.target.value })} placeholder="./chroma" />
          </Field>
        ) : null}
        {clientType === "http" ? (
          <>
            <Field label="Server host">
              <TextInput value={typeof client.host === "string" ? client.host : ""} onChange={(event) => writeClient({ host: event.target.value })} placeholder="localhost" />
            </Field>
            <Field label="Server port">
              <TextInput type="number" min={1} max={65535} inputMode="numeric" value={typeof client.port === "number" ? String(client.port) : ""} onChange={(event) => writeClient({ port: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="8000" />
            </Field>
          </>
        ) : null}
        {clientType === "cloud" ? (
          <>
            <Field label="Cloud tenant">
              <TextInput value={typeof client.tenant === "string" ? client.tenant : ""} onChange={(event) => writeClient({ tenant: event.target.value })} />
            </Field>
            <Field label="Cloud database">
              <TextInput value={typeof client.database === "string" ? client.database : ""} onChange={(event) => writeClient({ database: event.target.value })} />
            </Field>
          </>
        ) : null}
      </div>
      {isCreate ? (
        <Field label="Embedding function" hint="How text becomes vectors. none = you pass embeddings yourself.">
          <Select value={typeof spec.embedding_function === "string" ? spec.embedding_function : "default"} onChange={(event) => write({ embedding_function: event.target.value === "default" ? undefined : event.target.value })}>
            <option value="default">default (local sentence-transformer)</option>
            <option value="none">none (bring your own embeddings)</option>
            <option value="openai">openai (text-embedding-3-small)</option>
          </Select>
        </Field>
      ) : null}
      {FIELD_DEFS[op].map((def) => (
        <JsonField key={`${op}-${def.key}`} label={def.label} hint={def.hint} rows={def.rows} value={spec[def.key]} onValue={(value) => write({ [def.key]: value })} />
      ))}
      {op === "query" ? numberField("n_results", "n_results", "How many nearest records per query (default 10).", 1) : null}
      {op === "get" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {numberField("limit", "limit", "Maximum records to return.", 1)}
          {numberField("offset", "offset", "Records to skip.", 0)}
        </div>
      ) : null}
    </>
  );
}

const INITIAL = specToText(chroma.CHROMA_EXAMPLES.find((e) => e.id === "query-filtered")?.spec ?? chroma.CHROMA_EXAMPLES[0].spec);

export default function NosqlChroma() {
  return (
    <NosqlWorkbench
      adapter={adapter}
      initialText={INITIAL}
      renderForm={({ spec, setSpec }) => (
        <FormGroup title="Describe the operation">
          <ChromaForm spec={spec} setSpec={setSpec} />
        </FormGroup>
      )}
    />
  );
}
