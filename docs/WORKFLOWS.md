# Workflows

An n8n-style automation space inside Smart Knife: a canvas of nodes joined by connections, run by hand or by triggers
(schedule, webhook, sub-workflow call, error), with run history. The engine is Smart Knife's own (clean-room: n8n's code
is under the Sustainable Use License and is never copied); node names follow n8n's so people find what they know. Node
inventory and waves: [research/n8n-nodes.md](research/n8n-nodes.md).

## Rules

- **Workflow space only.** A run reaches workflow nodes and nothing else: no app tool, no assistant UI tool, no `knife_*`
  tool, no other account's data. The node registry (`src/lib/workflows/nodes/`) is the whole surface.
- **Runs happen in the workflow worker**, a separate Node process per run under the permission model: no fs writes,
  reads only inside the app directory, no child processes, no worker threads, no native addons, a scrubbed environment,
  a capped heap and a hard wall-clock kill. It never holds the storage key: the server opens what the run needs
  (workflow, credentials of the nodes that use them, input) and gets results back over IPC.
- **User code runs in QuickJS compiled to WebAssembly** inside that worker (Code node, expressions): no `require`, no
  `process`, no network, no timers, no host objects; memory, stack and time limits per evaluation; a failed or
  interrupted evaluation discards its WASM instance. Data crosses the boundary as JSON only.
- **Outbound requests** (HTTP Request and every integration) go through `src/lib/net/` like the assistant's provider
  calls: public mode refuses private, loopback and link-local addresses (re-checked per redirect hop) unless the account
  has the private-network opt-in; size and time caps hold.
- **Credentials** are per account, sealed at rest, never sent to the browser after saving (hints only), and given only to
  the node that names them. OAuth2 uses the user's own app (client id + secret they registered); instance-approved apps
  come later.
- **Limits** per run: wall clock, node executions, items per node output, output bytes, sub-workflow depth; per account:
  concurrent runs, runs per hour, active triggers, stored run history. A limit stops the run with a clear error.

## Model

- **Workflow** `{ id, name, nodes[], connections[], settings, active, updatedAt, version }` (`src/lib/workflows/types.ts`).
- **Node** `{ id, type, name (unique in the workflow), position [x, y], parameters, credentials?, disabled?, notes?,
  retryOnFail?, maxTries?, waitBetweenTries?, onError: "stop" | "continue" | "errorOutput" }`.
- **Connection** `{ from: { node, output }, to: { node, input } }` by node name, output/input index (Switch has several
  outputs, Merge two inputs, If true/false).
- **Items**: every node takes and returns arrays of `{ json: object, binary?: { [key]: BinaryRef }, pairedItem? }`.
  Binary data travels as references to run-scoped blobs, not inline in JSON.
- **Expressions**: a string parameter that starts with `=` is a template; `{{ … }}` parts are JavaScript evaluated in the
  sandbox with `$json`, `$binary`, `$input` (`all()`, `first()`, `last()`, `item`), `$("Node name")` (`.item`, `.all()`,
  `.first()`), `$node`, `$items`, `$now`, `$today`, `$workflow`, `$execution` (`id`, `mode`, `resumeUrl`), `$vars`,
  `$itemIndex`, `$runIndex`, `$prevNode`. A template that is one whole `{{ … }}` keeps the value's type.
- **Execution order**: from the start node, each node runs once its inputs are ready; branches run depth-first in output
  order (n8n's "v1" order), Merge waits for both inputs (or runs with one when the other branch never fires). Loops
  (Loop Over Items) re-enter until done. A disabled node passes its first input through.

## Triggers

| Trigger | Fires | Notes |
| --- | --- | --- |
| Manual | Run button in the editor, `POST /api/workflows/<id>/run` | test run, shows data per node |
| Schedule | interval or cron (workflow time zone) | active workflows only |
| Webhook | `…/api/hooks/<token>/<path>` (production, active only) and `…/api/hooks-test/<token>/<path>` (while the editor listens) | node auth (none, header, basic, bearer); body cap; respond immediately, when the last node finishes, or with Respond to Webhook |
| Wait (resume) | `$execution.resumeUrl` call, or the time | the run is saved as `waiting` and resumed |
| Execute Sub-workflow Trigger | another workflow of the same account | depth-limited |
| Error Trigger | a run of a workflow whose `settings.errorWorkflow` names this one fails | |

Webhook and resume routes are the only unauthenticated workflow routes: they bypass the session and Origin guard (like
the office callbacks), authenticate by an unguessable token (and the node's own auth), are rate limited per address and
per workflow, and never return a run's internal error text.

## Storage

Per account, sealed (`writeAccountFile`), counted in the account's storage quota (area `workflows`):
`$KNIFE_DATA_DIR/workflows/<account>/` with `workflows/<id>.json`, `runs/<workflowId>/<runId>.json` (kept: the last 100
per workflow and 14 days by default), `credentials.json`, `tables/` (Data Table node), `static.json` (Remove Duplicates
across runs, polling cursors).

## Code map

- `src/lib/workflows/types.ts` model (zod), `catalog/` node metadata (isomorphic), `nodes/` implementations (worker
  only), `engine/` executor + expressions + sandbox prelude, `sandbox/quickjs.ts`, `credential-types.ts`,
  `validate.ts`, `editor-model.ts`, `import.ts` (n8n exports), `client.ts` (browser API client).
- `src/lib/workflows/worker/`: the worker process (`main.ts`, `http.ts`, `protocol.ts`, `hooks.mjs` resolution hooks).
  It runs the TypeScript sources with Node's type stripping, not a bundle: code it imports uses erasable TypeScript
  only (no enums, namespaces, parameter properties) and explicit `…/index` imports for directories.
- `src/lib/workflows/server/`: `store.ts` (sealed per-account files), `trigger-index.ts`, `runner.ts` (worker processes,
  gate, live events), `hooks.ts` (webhook + resume routes), `scheduler.ts`, `oauth.ts`, `http.ts` (route errors).
- `src/app/api/workflows/…`, `src/app/api/hooks/…`, `src/app/api/hooks-test/…`; UI `src/tools/workflows/` (suite
  `workflows`, tabs `editor` and `credentials`).

## API

| Route | Does |
| --- | --- |
| `GET/POST /api/workflows` | list (workflows, credential hints, queue) / `{action:"create"}` |
| `GET/PUT/DELETE /api/workflows/<id>` | read (with webhook URLs, recent runs) / save (`version` must match, 409 otherwise; `active` activates) / delete |
| `POST /api/workflows/<id>/run` | `{startNode?, destinationNode?, draft?, items?, wait?}` -> 202 `{runId}` or, with `wait`, the result |
| `GET /api/workflows/<id>/runs`, `GET/POST/DELETE …/runs/<runId>` | history; one run (node data trimmed); `{action:"cancel"}`; delete |
| `GET …/runs/<runId>/events?after=N` | live progress (long poll, 20 s) |
| `POST/DELETE /api/workflows/<id>/listen` | wait (about 110 s) for one call of a test URL, which runs the posted draft |
| `POST /api/workflows/<id>/token` | new webhook URLs |
| `GET/POST /api/workflows/credentials` | hints / create, update (blank secret = keep), delete |
| `GET /api/workflows/oauth/start?credential=`, `…/oauth/callback` | OAuth2 with the user's own app (PKCE) |
| `* /api/hooks/<token>/<path>`, `* /api/hooks-test/<token>/<path>`, `GET/POST /api/hooks/resume/<token>` | webhooks, test webhooks, Wait resume |

## Limits (environment)

`KNIFE_WF_WORKERS` (4 worker processes at once), `KNIFE_WF_PER_ACCOUNT` (2), `KNIFE_WF_QUEUE` (50 waiting runs) and
`KNIFE_WF_QUEUE_PER_ACCOUNT` (10), `KNIFE_WF_TIMEOUT_SEC` (300 per run), `KNIFE_WF_HEAP_MB` (512 per worker),
`KNIFE_WF_BLOB_MB` (128 of files per run), `KNIFE_WF_HOOK_MAX_BYTES` (16 MB request body), `KNIFE_WF_HOOK_IP_PER_MIN`
(300), `KNIFE_WF_HOOK_PER_MIN` (120 per workflow), `KNIFE_WF_RUNS_PER_HOUR` (1000 triggered runs per account),
`KNIFE_WF_SCHEDULER=off` (no schedules or timed resumes in this process). Sandbox: 64 MB heap, 256 KB stack, Code node
up to 60 s, 2 s per expression, 1 s per regex in a condition. Engine: 5000 node executions, 50,000 items and about
64 MB per node output, sub-workflows 5 deep.

## Security notes

- The worker's flags (`workerExecArgv` in `runner.ts`): `--permission`, `--allow-fs-read=<app root, node_modules>`,
  `--allow-net`, `--max-old-space-size`, `--disallow-code-generation-from-strings`; started with `spawn` + an IPC slot
  (a `fork(path)` call would be traced into the Next bundle). `tests/workflow_runner.test.mjs` runs a probe under the
  same flags: writes, reads outside the app, child processes, worker threads and `eval` are refused.
- Webhook answers: the caller's `Cookie` is dropped before the run sees the request; `Set-Cookie`, CSP, HSTS, framing
  and CORS-credential headers from a run are dropped; every answer carries `Content-Security-Policy: sandbox`. In public
  mode a non-admin's workflow answers HTML/SVG/XML as `text/plain` (no pages on the instance's domain).
- A resume URL is claimed before its run starts (one resume per URL); disabled accounts run nothing; when the account's
  storage is full a run is kept without its node data (a waiting run fails instead).
- Run history counts toward the quota (area `workflows`).

## AI

AI Agent, Ask AI (n8n's Basic LLM Chain), Information Extractor and Text Classifier (`src/lib/workflows/nodes/ai.ts`)
call an OpenAI-compatible `/chat/completions` through the run's policy-checked HTTP client. The model comes from:

- a saved provider profile of the account (`source: "profile"`, `profile` = a profile id or empty for the active one):
  the server resolves it when the run starts and hands it to the node as its `provider` credential (the key never
  enters the workflow or the editor); profiles were checked by the same rules as the assistant's provider;
- or an "AI provider" credential (endpoint, key, model typed for this workflow; `source: "credential"`).

`model` on the node overrides the provider's model. The agent's tools are rows on the node (no sub-node wiring): HTTP
request (a URL template whose host is fixed by the author; the model fills `{placeholders}`, URL-encoded, plus a JSON
body for POST/PUT/PATCH), JavaScript (sandboxed, the arguments in `input`), a sub-workflow of the same account, a
calculator, the clock. Memory "per session key" keeps the last N messages in the workflow's static data. JSON answers
are parsed (fenced or surrounded by prose) and retried once when unreadable. A run makes at most 200 model calls. Every
call's token usage goes to the account's usage ledger (the same counters as the assistant).
