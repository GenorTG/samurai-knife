"use client";

import { useMemo, useState } from "react";
import { Button, CopyButton, Dropzone, Field, Notice, Panel, Select, TextArea, WorkStatus } from "@/components/ui";
import { downloadText, formatInt, readAsText } from "@/lib/format";
import { convertYamlJson, YAML_JSON_DISPLAY_LIMIT, YAML_JSON_INLINE_LIMIT, type YamlJsonFormat, type YamlJsonInput, type YamlJsonOutput } from "@/lib/yaml-json";
import { convertYamlJsonInWorker } from "@/lib/yaml-json-client";
import { useAdaptive } from "@/lib/workers/use-offloaded";

type Format = YamlJsonFormat;

const NO_RESULT: YamlJsonOutput = { output: "", errors: [], warnings: [] };

export default function YamlJsonConverter() {
  const [input, setInput] = useState("");
  const [inputFormat, setInputFormat] = useState<Format>("yaml");
  const [outputFormat, setOutputFormat] = useState<Format>("json");
  const [sort, setSort] = useState(false);

  const request = useMemo<YamlJsonInput>(() => ({ text: input, inputFormat, outputFormat, sort }), [input, inputFormat, outputFormat, sort]);
  const small = input.length <= YAML_JSON_INLINE_LIMIT;
  const job = useAdaptive(convertYamlJson, convertYamlJsonInWorker, request, small);
  const stale = job.status === "cancelled" || job.status === "error";
  const pending = job.status !== "done" && !stale;
  const result = stale ? NO_RESULT : job.value ?? NO_RESULT;
  const truncated = !small && result.output.length > YAML_JSON_DISPLAY_LIMIT;

  const loadFile = async (file: File) => {
    setInput(await readAsText(file));
    const extension = file.name.split(".").pop()?.toLowerCase();
    const detected: Format = extension === "json" ? "json" : "yaml";
    setInputFormat(detected);
    setOutputFormat(detected === "json" ? "yaml" : "json");
  };

  const outputExtension = outputFormat === "json" ? "json" : "yaml";

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Source">
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Input is">
                <Select value={inputFormat} onChange={(event) => setInputFormat(event.target.value as Format)}>
                  <option value="yaml">YAML</option>
                  <option value="json">JSON</option>
                </Select>
              </Field>
              <Field label="Convert to">
                <Select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as Format)}>
                  <option value="json">JSON</option>
                  <option value="yaml">YAML</option>
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={sort} onChange={(event) => setSort(event.target.checked)} />
              Sort object keys recursively
            </label>
            <TextArea
              rows={17}
              spellCheck={false}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={'name: Samurai Knife\nfeatures:\n  - convert\n  - lint'}
            />
            <WorkStatus running={job.status === "running"} elapsedMs={job.elapsedMs} label="Converting document" cancelLabel="Cancel conversion" onCancel={job.cancel} />
            {job.status === "cancelled" ? <Notice>Conversion cancelled. Edit the input or options to convert again.</Notice> : null}
            {job.status === "error" ? <Notice tone="error">{job.error}</Notice> : null}
            {pending && input.trim() ? (
              <Notice>Converting the document…</Notice>
            ) : result.errors.length ? (
              <div className="space-y-1">
                {result.errors.slice(0, 8).map((error) => <Notice key={error} tone="error">{error}</Notice>)}
              </div>
            ) : input.trim() && !stale ? (
              <Notice tone="good">Valid {inputFormat.toUpperCase()} document.</Notice>
            ) : stale ? null : (
              <Notice>Paste JSON or YAML, or choose a local file.</Notice>
            )}
            {result.warnings.map((warning) => <Notice key={warning}>{warning}</Notice>)}
            <Dropzone accept=".json,.yaml,.yml,application/json,text/yaml" hint="Open a .json, .yaml or .yml file — stays local" onFiles={(files) => void loadFile(files[0])} />
          </div>
        </Panel>

        <Panel
          title="Converted output"
          right={
            <div className="flex gap-1.5">
              <CopyButton text={result.output} />
              <Button
                size="sm"
                disabled={!result.output}
                onClick={() => downloadText(result.output, `converted.${outputExtension}`, outputFormat === "json" ? "application/json" : "application/yaml")}
              >
                Save .{outputExtension}
              </Button>
            </div>
          }
        >
          <TextArea readOnly rows={22} value={truncated ? result.output.slice(0, YAML_JSON_DISPLAY_LIMIT) : result.output} placeholder="Formatted output appears here…" />
          {truncated ? (
            <p className="mt-2 text-xs text-faint">Showing the first {formatInt(YAML_JSON_DISPLAY_LIMIT)} of {formatInt(result.output.length)} characters. Copy and Save .{outputExtension} use the full output.</p>
          ) : null}
        </Panel>
      </div>
      <p className="text-xs text-faint">Parsing, linting, sorting and conversion run in this tab. Duplicate mapping keys are reported instead of silently overwritten.</p>
    </div>
  );
}
