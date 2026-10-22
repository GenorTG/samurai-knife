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
