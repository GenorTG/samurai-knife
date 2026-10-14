"use client";

import { useState } from "react";
import { CopyButton, Field, Notice, Panel, Select, TextArea, TextInput } from "@/components/ui";
import * as mongo from "@/lib/nosql/mongo";
import { FormGroup, JsonField, NosqlWorkbench, orderKeys, specToText, type StoreAdapter } from "./nosql-workbench";

const adapter: StoreAdapter = {
  id: "mongo",
  name: "MongoDB",
  noun: "MongoDB operation",
  tools: { compile: "knife_mongo_compile", validate: "knife_mongo_validate" },
  parse: (text) => {
    const parsed = mongo.parseSpecText(text);
    return { spec: parsed.spec, issues: parsed.issues.filter((i) => i.severity === "error"), converted: parsed.convertedFromShell };
  },
  compile: mongo.compile,
  validate: mongo.validate,
  explain: mongo.explain,
  examples: mongo.MONGO_EXAMPLES,
};

interface FieldDef {
  key: string;
  label: string;
  hint: string;
  rows?: number;
}

const FILTER: FieldDef = { key: "filter", label: "Filter (JSON)", hint: 'Which documents. Example: {"status": "active", "age": {"$gte": 18}}', rows: 3 };
const OPTIONS: FieldDef = { key: "options", label: "Options (JSON)", hint: 'Optional. Example: {"upsert": true}', rows: 2 };
const FIELD_DEFS: Record<mongo.MongoOp, FieldDef[]> = {
  find: [FILTER, { key: "projection", label: "Projection (JSON)", hint: 'Fields to return. Example: {"name": 1, "_id": 0}', rows: 2 }, { key: "sort", label: "Sort (JSON)", hint: '1 ascending, -1 descending. Example: {"createdAt": -1}', rows: 2 }, OPTIONS],
  findOne: [FILTER, { key: "projection", label: "Projection (JSON)", hint: 'Example: {"name": 1}', rows: 2 }, { key: "sort", label: "Sort (JSON)", hint: 'Example: {"createdAt": -1}', rows: 2 }, OPTIONS],
  aggregate: [{ key: "pipeline", label: "Pipeline (JSON array)", hint: 'Stages run in order. Example: [{"$match": {"status": "paid"}}, {"$group": {"_id": "$customer", "total": {"$sum": "$amount"}}}]', rows: 6 }, OPTIONS],
  insertOne: [{ key: "document", label: "Document (JSON)", hint: 'Example: {"name": "Ada", "tags": ["admin"]}', rows: 5 }, OPTIONS],
  insertMany: [{ key: "documents", label: "Documents (JSON array)", hint: 'Example: [{"a": 1}, {"a": 2}]', rows: 5 }, OPTIONS],
  updateOne: [FILTER, { key: "update", label: "Update (JSON)", hint: 'Needs operators. Example: {"$set": {"status": "done"}, "$inc": {"n": 1}}', rows: 4 }, OPTIONS],
  updateMany: [FILTER, { key: "update", label: "Update (JSON)", hint: 'Needs operators. Example: {"$set": {"status": "done"}}', rows: 4 }, OPTIONS],
  replaceOne: [FILTER, { key: "replacement", label: "Replacement document (JSON)", hint: "A whole new document, without $operators.", rows: 4 }, OPTIONS],
  deleteOne: [FILTER, OPTIONS],
  deleteMany: [FILTER, OPTIONS],
  countDocuments: [FILTER, OPTIONS],
  distinct: [FILTER, OPTIONS],
  createIndex: [{ key: "keys", label: "Index keys (JSON)", hint: '1 ascending, -1 descending, or "text". Example: {"email": 1}', rows: 2 }, { key: "options", label: "Index options (JSON)", hint: 'Example: {"unique": true, "name": "email_idx"}', rows: 2 }],
};
const KEY_ORDER = ["op", "database", "collection", "filter", "projection", "sort", "limit", "skip", "update", "replacement", "pipeline", "document", "documents", "field", "keys", "options"];
const DEFAULTS: Record<mongo.MongoOp, Record<string, unknown>> = {
  find: { filter: {} },
  findOne: { filter: {} },
  aggregate: { pipeline: [{ $match: {} }] },
  insertOne: { document: {} },
  insertMany: { documents: [{}] },
  updateOne: { filter: {}, update: { $set: {} } },
  updateMany: { filter: {}, update: { $set: {} } },
  replaceOne: { filter: {}, replacement: {} },
  deleteOne: { filter: {} },
  deleteMany: { filter: {} },
  countDocuments: { filter: {} },
  distinct: { field: "name", filter: {} },
  createIndex: { keys: { field: 1 } },
};
const OP_LABEL: Record<mongo.MongoOp, string> = {
  find: "find: read documents",
  findOne: "findOne: read the first match",
  aggregate: "aggregate: pipeline of stages",
  insertOne: "insertOne: add a document",
  insertMany: "insertMany: add several documents",
  updateOne: "updateOne: change the first match",
  updateMany: "updateMany: change every match",
  replaceOne: "replaceOne: swap a whole document",
  deleteOne: "deleteOne: remove the first match",
  deleteMany: "deleteMany: remove every match",
  countDocuments: "countDocuments: count matches",
  distinct: "distinct: unique values of a field",
  createIndex: "createIndex: speed up queries",
};

function MongoForm({ spec, setSpec }: { spec: Record<string, unknown>; setSpec: (spec: Record<string, unknown>) => void }) {
  const op = (mongo.MONGO_OPS as readonly string[]).includes(String(spec.op)) ? (spec.op as mongo.MongoOp) : "find";
  const write = (patch: Record<string, unknown>) => setSpec(orderKeys({ ...spec, ...patch }, KEY_ORDER));
  const changeOp = (next: mongo.MongoOp) => {
    const allowed = new Set(mongo.MONGO_FIELDS[next]);
    const kept = Object.fromEntries(Object.entries(spec).filter(([key]) => allowed.has(key)));
    setSpec(orderKeys({ ...DEFAULTS[next], ...kept, op: next }, KEY_ORDER));
  };
  const numberField = (key: "limit" | "skip", label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <TextInput
        type="number"
        min={0}
        inputMode="numeric"
        value={typeof spec[key] === "number" ? String(spec[key]) : ""}
        onChange={(event) => write({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })}
      />
    </Field>
  );
  return (
    <>
      <Field label="Operation">
        <Select value={op} onChange={(event) => changeOp(event.target.value as mongo.MongoOp)}>
          {mongo.MONGO_OPS.map((name) => (
            <option key={name} value={name}>
              {OP_LABEL[name]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Collection" hint="The collection (table) name.">
          <TextInput value={typeof spec.collection === "string" ? spec.collection : ""} onChange={(event) => write({ collection: event.target.value })} placeholder="users" />
        </Field>
        <Field label="Database (optional)" hint="Leave empty to use your connection's default.">
          <TextInput value={typeof spec.database === "string" ? spec.database : ""} onChange={(event) => write({ database: event.target.value === "" ? undefined : event.target.value })} placeholder="shop" />
        </Field>
      </div>
      {op === "distinct" ? (
        <Field label="Field" hint="Which field to list unique values of.">
          <TextInput value={typeof spec.field === "string" ? spec.field : ""} onChange={(event) => write({ field: event.target.value })} placeholder="country" />
        </Field>
      ) : null}
      {FIELD_DEFS[op].map((def) => (
        <JsonField key={`${op}-${def.key}`} label={def.label} hint={def.hint} rows={def.rows} value={spec[def.key]} onValue={(value) => write({ [def.key]: value })} />
      ))}
      {op === "find" || op === "findOne" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {op === "find" ? numberField("limit", "Limit", "Maximum documents to return.") : null}
          {numberField("skip", "Skip", "Documents to skip (use with a sort).")}
        </div>
      ) : null}
    </>
  );
}

type Target = "relaxed" | "canonical" | "shell";

function ValueConverter() {
  const [input, setInput] = useState('{ _id: ObjectId("507f1f77bcf86cd799439011"), at: ISODate("2025-01-02T03:04:05Z"), n: NumberLong("9007199254740993") }');
  const [target, setTarget] = useState<Target>("relaxed");
  const converted = input.trim() ? mongo.convertValueText(input, target) : null;
  return (
    <Panel title="Convert a value" bodyClassName="space-y-3">
      <p className="text-xs text-faint">Paste mongosh syntax (ObjectId, ISODate, NumberLong, /regex/i…) or Extended JSON and get the other form.</p>
      <Field label="Value to convert">
        <TextArea rows={4} spellCheck={false} value={input} onChange={(event) => setInput(event.target.value)} />
      </Field>
      <Field label="Convert to">
        <Select value={target} onChange={(event) => setTarget(event.target.value as Target)}>
          <option value="relaxed">Extended JSON v2 (relaxed)</option>
          <option value="canonical">Extended JSON v2 (canonical)</option>
          <option value="shell">mongosh syntax</option>
        </Select>
      </Field>
      {converted && !converted.ok ? (
        <p role="alert" className="text-sm text-danger">
          Cannot convert: {converted.message}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="sk-label">Converted value</span>
        <CopyButton text={converted && converted.ok ? converted.text : ""} label="Copy converted value" />
      </div>
      <output aria-label="Converted value" data-agent-region="converted-value" className="sk-input block max-h-[40vh] min-h-16 overflow-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre">
        {converted && converted.ok ? converted.text : <span className="text-faint">The converted value appears here.</span>}
      </output>
      <Notice>Plain integers beyond 32 bits are stored as doubles by mongosh and the Node driver: write {'{"$numberLong": "…"}'} when you need a 64-bit integer.</Notice>
    </Panel>
  );
}

const INITIAL = specToText(mongo.MONGO_EXAMPLES[0].spec);

export default function NosqlMongo() {
  return (
    <NosqlWorkbench
      adapter={adapter}
      initialText={INITIAL}
      renderForm={({ spec, setSpec }) => (
        <FormGroup title="Describe the operation">
          <MongoForm spec={spec} setSpec={setSpec} />
        </FormGroup>
      )}
      extra={<ValueConverter />}
    />
  );
}
