# n8n documented nodes and Smart Knife delivery status

**As of 2026-10-26.** Every built-in node entry page in n8n's [official documentation index](https://docs.n8n.io/llms.txt)
(fetched 2026-10-26: 289,469 bytes, SHA-256 `67a065e4c835c37627a57c2625823d3f6440cd534f629906e2155dd6ff3b5bc8`), with
its priority for Smart Knife's own workflow engine and what exists in the code today. This is an exhaustive inventory of
that index, **not** of every piece of software, every community package or every operation of a node.
Proprietary services are listed: OAuth, paid API access or vendor review are delivery prerequisites, not reasons to leave
an integration out. Clean room: names, public documentation identities and documented behaviour only; no n8n code, node
definitions or UI are copied (n8n is under its [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)).

Engine contract: [WORKFLOWS.md](../WORKFLOWS.md). Build order and acceptance gates: [workflow-integrations-roadmap.md](workflow-integrations-roadmap.md).

## Counting rules

- One identity = one URL matching `/integrations/builtin/{core-nodes,app-nodes,trigger-nodes}/<id>.md`, or
  `/cluster-nodes/{root-nodes,sub-nodes}/<id>.md`. URLs, not labels, are identities (the Form step and the Form trigger
  share the label "n8n Form"). Operation how-tos, common-issues pages and category indexes are not counted.
- Credentials: one guide root per `/credentials/<id>.md` (a guide may cover several credential types).
- Community and verified-community packages are an open-ended ecosystem outside this baseline; a vendor API that is
  not listed here can still get its own adapter.

## What exists (main, 0.11)

**37 core node types + 4 AI nodes + 12 service nodes.** The core and AI nodes are in
`src/lib/workflows/catalog/*` and `nodes/*`; the service nodes are declarative specs in `src/lib/workflows/integrations/*`
(fixed documented API host, encoded path segments, every request through `sendAuthorized`), 26 operations in total.
Credential types: header, bearer, basic, query, custom JSON, OAuth2 with the user's own app (presets: Google, Meta,
Microsoft, GitHub, Slack, Discord, Notion, GitLab.com, custom), AI provider, JWT key, TOTP secret, SMTP; the Credentials
tab offers a setup recipe per service (scopes, console link, callback URL `<public URL>/api/workflows/oauth/callback`).
**Every external provider is provider-live unverified**: the service nodes are tested against provider-shaped fixtures
(`tests/workflow_integrations.test.mjs`), never against the real services.

| Code | Meaning |
| --- | --- |
| I | Implemented for the scope in the note (not every n8n operation) |
| P | Partial: a restricted equivalent, a few operations, or a feature embedded in another node |
| N | Not implemented as the named node |
| X | Excluded, with the reason |

| Category | Entries | I | P | N | X |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core | 69 | 30 | 7 | 24 | 8 |
| AI cluster (roots / sub-nodes) | 95 (24 / 71) | 0 | 8 | 87 | 0 |
| App actions | 275 | 0 | 12 | 261 | 2 |
| App triggers | 91 | 0 | 0 | 91 | 0 |
| **Total** | **530** | **30** | **27** | **463** | **10** |

Priority (kept from the 2026-10-22 list): **1** first engine release, **2** next core work, **3 / 3+** AI work, **A** first
integrations backlog, **B** later integrations, **P** specialist review (protocol or unusual auth), **-** excluded.
A priority is not a status: several priority-1 core nodes are still N.

## Authentication and provider registration

A credential guide is research input, not proof that Smart Knife supports the mechanism. **SVC** = service-specific
auth not audited yet: read the node's credential guide and record operations, scopes and grant type before coding.

| Gate | Services | Provider-side prerequisites | Gap in Smart Knife |
| --- | --- | --- | --- |
| G | Gmail, Sheets, Drive, Docs, Calendar, Analytics, Ads, Tasks, Contacts, Cloud APIs | Cloud project; enable each API; consent screen and test users; Web OAuth client with the exact callback; per-operation scopes; verification for sensitive scopes; Ads needs a developer token; service accounts need a key and IAM or domain-wide delegation | User OAuth only; no service-account JWT exchange; scopes per recipe |
| MS | Outlook, OneDrive, Teams, Excel, SharePoint, To Do, Graph, Dynamics | Entra app registration; tenant/account audience; Web callback; secret or certificate; delegated or application permissions; admin consent where required | Delegated common-tenant OAuth only; no certificate assertion or app-only flow |
| META | Facebook Graph, Instagram, WhatsApp (+ triggers) | Meta developer app; products and Facebook Login for Business; callback; page/business permissions; app review for live mode; WhatsApp business portfolio, phone assets; webhook verification and signatures | Preset only; no page/system-user tokens, no webhook verification |
| GH | GitHub (+ trigger) | PAT with repository permissions or own OAuth app; organisation policies; hook permissions for triggers | Issues node implemented; no hook lifecycle |
| SL | Slack (+ trigger) | Slack app, bot/user scopes, workspace install; Events API needs a request URL, challenge and signing secret | Bot token / OAuth; no event verification |
| DC | Discord | Webhook URL for channel-only posting, or app + bot token + guild/channel permissions | Bot token as header; no webhook-URL mode |
| NO | Notion | Internal integration secret + page sharing, or public integration with client credentials | Token or OAuth; pages must be shared |
| LI | LinkedIn | Developer app linked to a Company Page; approved products/scopes (posting, Lead Sync reviewed separately) | Nothing yet |
| SH | Shopify (+ trigger) | Store or partner app, Admin API scopes, access token or OAuth, webhook secret | Nothing yet |
| SF | Salesforce (+ trigger) | Org with API access; External Client App or Connected App; callback, scopes, token policy; sandbox vs production | No preset; no JWT-bearer grant |
| AWS | S3, SNS, SQS, DynamoDB, Bedrock, … | Account, region, least-privilege IAM; access keys or a role flow; SigV4 | No SigV4/STS; never ambient host credentials |
| PROTO | Databases, brokers, IMAP, SSH/FTP | Endpoint, port, credentials, TLS/CA; a protocol driver and a checked network boundary | No workflow drivers yet |
| SVC | Every other service | Per-service auth mode, plan, region/base URL, scopes, rate limits, review | Not audited individually |

Triggers add their own work even when the action's auth is known: webhook registration/renewal/removal, challenge and
signature checks on the raw body, deduplication and replay protection, or a polling cursor with at-least-once semantics.
Core Webhook and Schedule alone do not cover that.

## Core nodes (69)

| Node | Priority | State | Local type | Scope / gap |
| --- | --- | --- | --- | --- |
| [Activation Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.activationtrigger.md) | - | X | — | n8n lifecycle-specific; workflow activation is not an event node here. |
| [Aggregate](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.aggregate.md) | 1 | I | `core.aggregate` | Collect selected fields or all item JSON into arrays. |
| [AI Transform](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.aitransform.md) | 3 | N | — | Planned: AI node family (phase 3): instruction -> generated Code node. |
| [Code](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.code.md) | 1 | P | `core.code` | JavaScript in QuickJS-WASM only; no Python or host modules. |
| [Compare Datasets](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.comparedatasets.md) | 1 | I | `core.compare-datasets` | Compare two inputs; four result branches. |
| [Compression](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.compression.md) | 1 | P | `core.compression` | gzip/gunzip only; ZIP archives are not implemented. |
| [Chat Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger.md) | 2 | N | — | Planned: Hosted chat page / embeddable widget, pairs with the AI Agent node. |
| [Convert to File](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.converttofile.md) | 1 | P | `core.convert-to-file` | CSV, JSON, text, base64 decode and ICS only; no XLSX, ODS or HTML export. |
| [Crypto](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.crypto.md) | 1 | I | `core.crypto` | Hash/HMAC/sign/random values. |
| [Data Table](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable.md) | 1 | N | — | Planned: Per-account tables stored in the workflow space (insert, update, upsert, get, delete). |
| [Date & Time](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datetime.md) | 1 | I | `core.date-time` | Date operations through the sandbox date prelude. |
| [Debug Helper](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.debughelper.md) | 1 | P | `core.debug-helper` | Test data, throw an error, no-op; deliberate memory exhaustion excluded. |
| [Edit Fields (Set)](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.set.md) | 1 | I | `core.set` | Label Edit Fields; manual/JSON mappings and field selection. |
| [Edit Image](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.editimage.md) | 2 | N | — | Planned: Resize, crop, rotate, text, composite; uses the app's image code without the UI. |
| [Email Trigger (IMAP)](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.emailimap.md) | 2 | N | — | Planned: Polling IMAP with the user's credential. |
| [Error Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.errortrigger.md) | 1 | I | `core.error-trigger` | Error-workflow dispatch within the same account. |
| [Evaluation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.evaluation.md) | 3 | N | — | Planned: Datasets + metrics for AI workflows. |
| [Evaluation Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.evaluationtrigger.md) | 3 | N | — | Planned: needs a scoped contract and an implementation. |
| [Execute Command](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executecommand.md) | - | X | — | Excluded: shell on the host breaks the worker boundary. |
| [Execute Sub-workflow](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow.md) | 1 | I | `core.execute-workflow` | Same-account calls; depth/timeout limits apply. |
| [Execute Sub-workflow Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflowtrigger.md) | 1 | I | `core.execute-workflow-trigger` | Same-account sub-workflow entry point. |
| [Execution Data](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executiondata.md) | 1 | I | `core.execution-data` | Custom run data searchable in the run history. |
| [Extract From File](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.extractfromfile.md) | 1 | P | `core.extract-from-file` | CSV, JSON, text and base64 only; no XLSX/ODS/PDF/HTML/ICS/RTF extraction. |
| [Filter](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.filter.md) | 1 | I | `core.filter` | Typed conditions; kept/discarded routing. |
| [FTP](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ftp.md) | 2 | N | — | Planned: FTP/SFTP to the user's server through the outbound policy. |
| [Git](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.git.md) | 3 | N | — | Planned: Clone/commit/push in a throwaway sandboxed checkout. |
| [GraphQL](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.graphql.md) | 1 | I | `core.graphql` | POST query/variables/operation name through the guarded HTTP transport. |
| [Guardrails](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.guardrails.md) | 3 | N | — | Planned: AI node family (phase 3). |
| [HTML](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.html.md) | 1 | N | — | Planned: Extract with CSS selectors, generate a template, convert to table. |
| [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest.md) | 1 | P | `core.http-request` | Methods, query/headers, JSON/form/multipart/raw/binary; no built-in pagination loop. |
| [If](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.if.md) | 1 | I | `core.if` | Typed conditions; true/false outputs. |
| [JWT](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.jwt.md) | 1 | I | `core.jwt` | Sign/decode/verify (HS/RS/ES256) with jwtAuth. |
| [LDAP](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ldap.md) | 3 | N | — | Planned: Protocol client, outbound policy. |
| [Limit](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.limit.md) | 1 | I | `core.limit` | First/last N items. |
| [Local File Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.localfiletrigger.md) | - | X | — | Excluded: watches the host filesystem. |
| [Loop Over Items (Split in Batches)](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitinbatches.md) | 1 | I | `core.loop` | Batch loop and done outputs. |
| [Manual Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.manualworkflowtrigger.md) | 1 | I | `core.manual-trigger` | Run from the editor or the API. |
| [Markdown](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.markdown.md) | 1 | P | `core.markdown` | Markdown to HTML only; HTML to Markdown is not implemented. |
| [MCP Client](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcpclient.md) | 2 | N | — | Planned: Call tools of any MCP server the user adds. |
| [MCP Server Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger.md) | 2 | N | — | Planned: Expose a workflow as an MCP tool on the account's MCP endpoint. |
| [Merge](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.merge.md) | 1 | I | `core.merge` | Append, join by fields/position, every combination, choose an input. |
| [Message an Agent](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.messageanagent.md) | 3 | N | — | Planned: AI node family (phase 3). |
| [n8n](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.n8n.md) | - | X | — | n8n's own administration API; use Smart Knife's API/MCP instead. |
| [n8n Form](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.form.md) | 2 | N | — | Planned: hosted form page/continuation step (distinct from the Form trigger). |
| [n8n Form](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger.md) | 2 | N | — | Planned: hosted form trigger (distinct from the Form step). |
| [n8n Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.n8ntrigger.md) | - | X | — | n8n lifecycle events; no equivalent. |
| [No Operation, do nothing](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.noop.md) | 1 | I | `core.no-op` | Label No Operation; passes items through. |
| [Read/Write Files from Disk](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.readwritefile.md) | - | X | — | Excluded: host filesystem access (account-scoped file nodes can be designed separately). |
| [Remove Duplicates](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.removeduplicates.md) | 1 | I | `core.remove-duplicates` | Within the input or across runs (stored keys). |
| [Rename Keys](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.renamekeys.md) | 1 | I | `core.rename-keys` | Configured key mappings. |
| [Chat](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chat.md) | 2 | N | — | Planned: Send a message to the chat user and wait for the reply. |
| [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook.md) | 1 | I | `core.respond-to-webhook` | JSON/text/binary/redirect response, filtered by the server. |
| [RSS Read](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.rssfeedread.md) | 1 | N | — | Planned: needs a scoped contract and an implementation. |
| [RSS Feed Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.rssfeedreadtrigger.md) | 2 | N | — | Planned: Polling, new items only. |
| [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger.md) | 1 | I | `core.schedule-trigger` | Interval/cron; active workflows only. |
| [Send Email](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.sendemail.md) | 1 | N | — | Planned: SMTP credential of the user (never the instance mailer). |
| [Sort](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.sort.md) | 1 | I | `core.sort` | Fields, random or custom comparator. |
| [Split Out](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.splitout.md) | 1 | I | `core.split-out` | A list field into items. |
| [SSE Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ssetrigger.md) | 2 | N | — | Planned: Listen to a server-sent events URL (long-lived, worker slot cost). |
| [SSH](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.ssh.md) | 2 | N | — | Planned: Commands on the user's own server (outbound only, never this host). |
| [Stop And Error](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.stopanderror.md) | 1 | I | `core.stop-and-error` | Fails the run with a node error. |
| [Summarize](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.summarize.md) | 1 | I | `core.summarize` | Aggregate/group configured fields. |
| [Switch](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.switch.md) | 1 | I | `core.switch` | Rules or expression routing. |
| [TOTP](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.totp.md) | 1 | I | `core.totp` | Stored base32 secret, SHA1/256/512. |
| [Track Time Saved](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.timesaved.md) | - | X | — | n8n insights feature, not a workflow action. |
| [Wait](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait.md) | 1 | I | `core.wait` | Interval, date or resume URL. |
| [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook.md) | 1 | I | `core.webhook` | Test/production URLs; header/basic/bearer auth; not a vendor-signature verifier. |
| [Workflow Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.workflowtrigger.md) | 1 | X | — | Legacy lifecycle trigger; the explicit sub-workflow trigger is implemented. |
| [XML](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.xml.md) | 1 | N | — | Planned: XML <-> JSON. |

## AI cluster nodes (95)

The four AI nodes use the account's provider profiles or an AI provider credential (OpenAI-compatible `/chat/completions`).
Native Anthropic/Gemini/Bedrock protocols, embeddings, rerankers, vector stores and remote memory are not implemented.

| Node | Kind | Priority | State | Local equivalent / gap |
| --- | --- | --- | --- | --- |
| [AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent.md) | root | 3 | P | `ai-agent` — Own tool-loop agent, not n8n's root/sub-node cluster. |
| [Basic LLM Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainllm.md) | root | 3 | P | `ai-chat` — Ask AI: one chat completion per item, text or JSON. |
| [Question and Answer Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainretrievalqa.md) | root | 3+ | N | No standalone implementation. |
| [Summarization Chain](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.chainsummarization.md) | root | 3 | N | No standalone implementation. |
| [Information Extractor](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.information-extractor.md) | root | 3 | P | `ai-extract` — Prompted extraction with typed fields. |
| [Text Classifier](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.text-classifier.md) | root | 3 | P | `ai-classify` — Routes items by model classification; no model sub-node wiring. |
| [Sentiment Analysis](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.sentimentanalysis.md) | root | 3 | N | No standalone implementation. |
| [LangChain Code](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.code.md) | root | 3+ | N | No standalone implementation. |
| [Microsoft Agent 365 Trigger](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.microsoftagent365trigger.md) | root | 3+ | N | No standalone implementation. |
| [Databricks AI Agent](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.databricksaiagent.md) | root | 3+ | N | No standalone implementation. |
| [Azure AI Search Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreazureaisearch.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Simple Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreinmemory.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Milvus Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoremilvus.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [MongoDB Atlas Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoremongodbatlas.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [PGVector Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstorepgvector.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Oracle Database Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreoracledb.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Chroma Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstorechroma.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Databricks Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoredatabricks.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Pinecone Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstorepinecone.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Qdrant Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreqdrant.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Redis Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreredis.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Supabase Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoresupabase.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Weaviate Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoreweaviate.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Zep Vector Store](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstorezep.md) | root | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Default Data Loader](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.documentdefaultdataloader.md) | sub-node | 3+ | N | No standalone implementation. |
| [GitHub Document Loader](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.documentgithubloader.md) | sub-node | 3+ | N | No standalone implementation. |
| [Embeddings AWS Bedrock](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsawsbedrock.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Microsoft Foundry Embeddings](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsazureopenai.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Cohere](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingscohere.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Databricks](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsdatabricks.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Google Gemini](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsgooglegemini.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Google PaLM](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsgooglepalm.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Google Vertex](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsgooglevertex.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings HuggingFace Inference](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingshuggingfaceinference.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Lemonade](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingslemonade.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Mistral Cloud](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsmistralcloud.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Ollama](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsollama.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings OpenAI](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsopenai.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Embeddings Oracle Database](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.embeddingsoracledb.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Qwen Cloud Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatalibabacloud.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Anthropic Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatanthropic.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [AWS Bedrock Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatawsbedrock.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Microsoft Foundry Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatazureopenai.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Cohere Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatcohere.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Databricks Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatdatabricks.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [DeepSeek Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatdeepseek.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Google Gemini Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatgooglegemini.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Google Vertex Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatgooglevertex.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Groq Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatgroq.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Lemonade Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatlemonade.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [MiniMax Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatminimax.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Mistral Cloud Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatmistralcloud.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Moonshot Kimi Chat Model node](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatmoonshot.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [NVIDIA Nemotron Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatnvidia.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Ollama Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatollama.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [OpenAI Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [OpenRouter Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenrouter.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Vercel AI Gateway Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatvercel.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [xAI Grok Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatxaigrok.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Cohere Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmcohere.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Lemonade Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmlemonade.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Ollama Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmollama.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Hugging Face Inference Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmopenhuggingfaceinference.md) | sub-node | 3 (as Chat model) | N | No standalone model sub-node; a provider adapter must be verified, not inferred from the name. |
| [Chat Memory Manager](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorymanager.md) | sub-node | 3+ | N | No standalone implementation. |
| [Simple Memory](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorybufferwindow.md) | sub-node | 3 | P | `in ai-agent` — Session memory in workflow static data, not a standalone sub-node. |
| [Motorhead](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorymotorhead.md) | sub-node | 3+ | N | No standalone implementation. |
| [MongoDB Chat Memory](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorymongochat.md) | sub-node | 3+ | N | No standalone implementation. |
| [Redis Chat Memory](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memoryredischat.md) | sub-node | 3+ | N | No standalone implementation. |
| [Postgres Chat Memory](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memorypostgreschat.md) | sub-node | 3+ | N | No standalone implementation. |
| [Xata](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memoryxata.md) | sub-node | 3+ | N | No standalone implementation. |
| [Zep](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.memoryzep.md) | sub-node | 3+ | N | No standalone implementation. |
| [Auto-fixing Output Parser](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.outputparserautofixing.md) | sub-node | 3 | N | No standalone implementation. |
| [Item List Output Parser](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.outputparseritemlist.md) | sub-node | 3 | N | No standalone implementation. |
| [Structured Output Parser](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.outputparserstructured.md) | sub-node | 3 | N | No standalone implementation. |
| [Contextual Compression Retriever](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.retrievercontextualcompression.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [MultiQuery Retriever](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.retrievermultiquery.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Vector Store Retriever](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.retrievervectorstore.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Workflow Retriever](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.retrieverworkflow.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Character Text Splitter](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.textsplittercharactertextsplitter.md) | sub-node | 3 | N | No standalone implementation. |
| [Recursive Character Text Splitter](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.textsplitterrecursivecharactertextsplitter.md) | sub-node | 3 | N | No standalone implementation. |
| [Token Splitter](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.textsplittertokensplitter.md) | sub-node | 3+ | N | No standalone implementation. |
| [AI Agent Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolaiagent.md) | sub-node | 3 | N | No standalone implementation. |
| [Calculator](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolcalculator.md) | sub-node | 3 | P | `in ai-agent` — Calculator tool row of the agent. |
| [Custom Code Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolcode.md) | sub-node | 3 | P | `in ai-agent` — Sandboxed JavaScript tool row of the agent. |
| [Databricks Genie One MCP server](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-mcp-registry.databricksgenie.md) | sub-node | 3+ | N | No standalone implementation. |
| [MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp.md) | sub-node | 3 | N | No standalone implementation. |
| [SearXNG Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolsearxng.md) | sub-node | 3 | N | No standalone implementation. |
| [SerpApi (Google Search)](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolserpapi.md) | sub-node | 3+ | N | No standalone implementation. |
| [Think Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolthink.md) | sub-node | 3 | N | No standalone implementation. |
| [Vector Store Question Answer Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolvectorstore.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Wikipedia](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolwikipedia.md) | sub-node | 3 | N | No standalone implementation. |
| [Wolfram\|Alpha tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolwolframalpha.md) | sub-node | 3+ | N | No standalone implementation. |
| [Call n8n Workflow Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolworkflow.md) | sub-node | 3 | P | `in ai-agent` — Calls a Smart Knife workflow of the same account. |
| [Reranker Cohere](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.rerankercohere.md) | sub-node | 3+ | N | No retrieval/embedding/vector implementation yet. |
| [Model Selector](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.modelselector.md) | sub-node | 3 | N | No standalone implementation. |

## App action nodes (275)

Auth gates refer to the table above. P rows are the 12 service nodes (a few operations each; see the note).

| Node | Priority | State | Auth gate | Smart Knife |
| --- | --- | --- | --- | --- |
| [Action Network](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.actionnetwork.md) | B | N | SVC |  |
| [ActiveCampaign](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.activecampaign.md) | B | N | SVC |  |
| [Adalo](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.adalo.md) | B | N | SVC |  |
| [Affinity](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.affinity.md) | B | N | SVC |  |
| [Agile CRM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.agilecrm.md) | B | N | SVC |  |
| [Airtable](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.airtable.md) | A | P | SVC | `core.airtable`: list records, create a record |
| [Airtop](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.airtop.md) | B | N | SVC |  |
| [Qwen Cloud](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.alibabacloud.md) | B | N | SVC |  |
| [AMQP Sender](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.amqp.md) | P | N | PROTO |  |
| [Anthropic](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.anthropic.md) | A | N | SVC |  |
| [APITemplate.io](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.apitemplateio.md) | B | N | SVC |  |
| [Asana](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.asana.md) | A | N | SVC |  |
| [Autopilot](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.autopilot.md) | B | N | SVC |  |
| [AWS Certificate Manager](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awscertificatemanager.md) | B | N | AWS |  |
| [AWS Cognito](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awscognito.md) | B | N | AWS |  |
| [AWS Comprehend](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awscomprehend.md) | B | N | AWS |  |
| [AWS DynamoDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awsdynamodb.md) | B | N | AWS |  |
| [AWS Elastic Load Balancing](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awselb.md) | B | N | AWS |  |
| [AWS IAM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awsiam.md) | B | N | AWS |  |
| [AWS Lambda](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awslambda.md) | B | N | AWS |  |
| [AWS Rekognition](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awsrekognition.md) | B | N | AWS |  |
| [AWS S3](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awss3.md) | A | N | AWS |  |
| [AWS SES](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awsses.md) | B | N | AWS |  |
| [AWS SNS](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awssns.md) | B | N | AWS |  |
| [AWS SQS](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awssqs.md) | B | N | AWS |  |
| [AWS Textract](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awstextract.md) | B | N | AWS |  |
| [AWS Transcribe](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.awstranscribe.md) | B | N | AWS |  |
| [Azure Cosmos DB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.azurecosmosdb.md) | P | N | SVC |  |
| [Azure Storage](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.azurestorage.md) | B | N | SVC |  |
| [BambooHR](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.bamboohr.md) | B | N | SVC |  |
| [Bannerbear](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.bannerbear.md) | B | N | SVC |  |
| [Baserow](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.baserow.md) | A | N | SVC |  |
| [Beeminder](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.beeminder.md) | B | N | SVC |  |
| [Bitly](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.bitly.md) | A | N | SVC |  |
| [Bitwarden](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.bitwarden.md) | A | N | SVC |  |
| [Box](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.box.md) | B | N | SVC |  |
| [Brandfetch](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.brandfetch.md) | B | N | SVC |  |
| [Brevo](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.brevo.md) | A | N | SVC |  |
| [Bubble](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.bubble.md) | B | N | SVC |  |
| [Chargebee](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.chargebee.md) | B | N | SVC |  |
| [CircleCI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.circleci.md) | B | N | SVC |  |
| [Webex by Cisco](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.ciscowebex.md) | B | N | SVC |  |
| [Clearbit](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.clearbit.md) | B | N | SVC |  |
| [ClickUp](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.clickup.md) | A | N | SVC |  |
| [Clockify](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.clockify.md) | B | N | SVC |  |
| [Cloudflare](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.cloudflare.md) | A | N | SVC |  |
| [Cockpit](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.cockpit.md) | B | N | SVC |  |
| [Coda](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.coda.md) | B | N | SVC |  |
| [CoinGecko](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.coingecko.md) | A | N | SVC |  |
| [Confluence](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.confluence.md) | B | N | SVC |  |
| [Contentful](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.contentful.md) | A | N | SVC |  |
| [ConvertKit](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.convertkit.md) | B | N | SVC |  |
| [Copper](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.copper.md) | B | N | SVC |  |
| [Cortex](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.cortex.md) | B | N | SVC |  |
| [CrateDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.cratedb.md) | P | N | PROTO |  |
| [Customer.io](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.customerio.md) | B | N | SVC |  |
| [Databricks](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.databricks.md) | P | N | SVC |  |
| [DeepL](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.deepl.md) | A | N | SVC |  |
| [Demio](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.demio.md) | B | N | SVC |  |
| [DHL](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.dhl.md) | B | N | SVC |  |
| [Discord](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.discord.md) | A | P | DC | `core.discord`: send a message, list channel messages (bot token) |
| [Discourse](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.discourse.md) | B | N | SVC |  |
| [Disqus](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.disqus.md) | B | N | SVC |  |
| [Drift](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.drift.md) | B | N | SVC |  |
| [Dropbox](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.dropbox.md) | A | N | SVC |  |
| [Dropcontact](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.dropcontact.md) | B | N | SVC |  |
| [E-goi](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.egoi.md) | B | N | SVC |  |
| [Elasticsearch](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.elasticsearch.md) | A | N | SVC |  |
| [Elastic Security](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.elasticsecurity.md) | B | N | SVC |  |
| [Emelia](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.emelia.md) | B | N | SVC |  |
| [ERPNext](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.erpnext.md) | B | N | SVC |  |
| [Facebook Graph API](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.facebookgraphapi.md) | A | N | META |  |
| [FileMaker](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.filemaker.md) | P | N | SVC |  |
| [Flow](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.flow.md) | B | N | SVC |  |
| [Freshdesk](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.freshdesk.md) | A | N | SVC |  |
| [Freshservice](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.freshservice.md) | B | N | SVC |  |
| [Freshworks CRM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.freshworkscrm.md) | B | N | SVC |  |
| [GetResponse](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.getresponse.md) | B | N | SVC |  |
| [Ghost](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.ghost.md) | A | N | SVC |  |
| [GitHub](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.github.md) | A | P | GH | `core.github`: list issues, get an issue, create an issue |
| [GitLab](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gitlab.md) | A | P | SVC | `core.gitlab`: list project issues, create an issue (GitLab.com only) |
| [Gmail](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gmail.md) | A | N | G |  |
| [Gong](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gong.md) | B | N | SVC |  |
| [Google Ads](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googleads.md) | A | N | G |  |
| [Google Analytics](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googleanalytics.md) | A | N | G |  |
| [Google BigQuery](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlebigquery.md) | A | N | G |  |
| [Google Books](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlebooks.md) | B | N | G |  |
| [Google Business Profile](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlebusinessprofile.md) | A | N | G |  |
| [Google Calendar](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecalendar.md) | A | P | G | `core.google-calendar`: list events, create a timed event |
| [Google Chat](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlechat.md) | A | N | G |  |
| [Google Cloud Firestore](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecloudfirestore.md) | P | N | G |  |
| [Google Cloud Natural Language](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecloudnaturallanguage.md) | B | N | G |  |
| [Google Cloud Realtime Database](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecloudrealtimedatabase.md) | P | N | G |  |
| [Google Cloud Storage](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecloudstorage.md) | B | N | G |  |
| [Google Contacts](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlecontacts.md) | A | N | G |  |
| [Google Docs](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googledocs.md) | A | N | G |  |
| [Google Drive](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googledrive.md) | A | P | G | `core.google-drive`: list files, create a folder |
| [Google Gemini](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.googlegemini.md) | A | N | G |  |
| [Google Perspective](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googleperspective.md) | B | N | G |  |
| [Google Sheets](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googlesheets.md) | A | P | G | `core.google-sheets`: read a range, append rows |
| [Google Slides](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googleslides.md) | A | N | G |  |
| [Google Tasks](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googletasks.md) | A | N | G |  |
| [Google Translate](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googletranslate.md) | A | N | G |  |
| [Google Workspace Admin](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gsuiteadmin.md) | B | N | G |  |
| [Gotify](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gotify.md) | A | N | SVC |  |
| [GoToWebinar](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.gotowebinar.md) | B | N | SVC |  |
| [Grafana](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.grafana.md) | A | N | SVC |  |
| [Grist](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.grist.md) | A | N | SVC |  |
| [Hacker News](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.hackernews.md) | A | N | SVC |  |
| [HaloPSA](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.halopsa.md) | B | N | SVC |  |
| [Harvest](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.harvest.md) | B | N | SVC |  |
| [Help Scout](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.helpscout.md) | B | N | SVC |  |
| [HighLevel](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.highlevel.md) | B | N | SVC |  |
| [Home Assistant](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.homeassistant.md) | A | N | SVC |  |
| [HubSpot](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.hubspot.md) | A | P | SVC | `core.hubspot`: list contacts, create a contact |
| [Humantic AI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.humanticai.md) | B | N | SVC |  |
| [Hunter](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.hunter.md) | B | N | SVC |  |
| [Intercom](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.intercom.md) | A | N | SVC |  |
| [Invoice Ninja](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.invoiceninja.md) | B | N | SVC |  |
| [Iterable](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.iterable.md) | B | N | SVC |  |
| [Jenkins](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.jenkins.md) | B | N | SVC |  |
| [Jina AI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.jinaai.md) | B | N | SVC |  |
| [Jira Software](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.jira.md) | A | N | SVC |  |
| [Kafka](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.kafka.md) | P | N | PROTO |  |
| [Keap](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.keap.md) | B | N | SVC |  |
| [Kitemaker](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.kitemaker.md) | B | N | SVC |  |
| [KoboToolbox](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.kobotoolbox.md) | B | N | SVC |  |
| [Lemlist](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.lemlist.md) | B | N | SVC |  |
| [Line](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.line.md) | B | N | SVC |  |
| [Linear](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.linear.md) | A | N | SVC |  |
| [LingvaNex](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.lingvanex.md) | B | N | SVC |  |
| [LinkedIn](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.linkedin.md) | A | N | LI |  |
| [LoneScale](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.lonescale.md) | B | N | SVC |  |
| [Magento 2](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.magento2.md) | B | N | SVC |  |
| [Mailcheck](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mailcheck.md) | B | N | SVC |  |
| [Mailchimp](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mailchimp.md) | A | N | SVC |  |
| [MailerLite](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mailerlite.md) | A | N | SVC |  |
| [Mailgun](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mailgun.md) | A | N | SVC |  |
| [Mailjet](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mailjet.md) | B | N | SVC |  |
| [Mandrill](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mandrill.md) | B | N | SVC |  |
| [marketstack](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.marketstack.md) | B | N | SVC |  |
| [Matrix](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.matrix.md) | A | N | SVC |  |
| [Mattermost](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mattermost.md) | A | N | SVC |  |
| [Mautic](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mautic.md) | B | N | SVC |  |
| [Medium](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.medium.md) | B | N | SVC |  |
| [MessageBird](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.messagebird.md) | B | N | SVC |  |
| [Metabase](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.metabase.md) | B | N | SVC |  |
| [Microsoft Dataverse](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftdataverse.md) | B | N | MS |  |
| [Microsoft Dynamics CRM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftdynamicscrm.md) | B | N | MS |  |
| [Microsoft Entra ID](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftentra.md) | B | N | MS |  |
| [Microsoft Excel (OneDrive)](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftexcel.md) | A | N | MS |  |
| [Microsoft Excel (SharePoint)](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftexcelsharepoint.md) | B | N | MS |  |
| [Microsoft Graph Security](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftgraphsecurity.md) | B | N | MS |  |
| [Microsoft OneDrive](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftonedrive.md) | A | N | MS |  |
| [Microsoft Outlook](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftoutlook.md) | A | P | MS | `core.microsoft-outlook`: list mail messages, send mail |
| [Microsoft SharePoint](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftsharepoint.md) | B | N | MS |  |
| [Microsoft SQL](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftsql.md) | P | N | MS |  |
| [Microsoft Teams](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsoftteams.md) | A | P | MS | `core.microsoft-teams`: list channel messages, send a channel message |
| [Microsoft To Do](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.microsofttodo.md) | A | N | MS |  |
| [Mindee](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mindee.md) | B | N | SVC |  |
| [MISP](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.misp.md) | B | N | SVC |  |
| [Mistral AI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mistralai.md) | A | N | SVC |  |
| [MiniMax](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.minimax.md) | B | N | SVC |  |
| [Mocean](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mocean.md) | B | N | SVC |  |
| [monday.com](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mondaycom.md) | A | N | SVC |  |
| [MongoDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mongodb.md) | A | N | PROTO |  |
| [Monica CRM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.monicacrm.md) | B | N | SVC |  |
| [Moonshot Kimi](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.moonshot.md) | B | N | SVC |  |
| [MQTT](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mqtt.md) | P | N | PROTO |  |
| [MSG91](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.msg91.md) | B | N | SVC |  |
| [MySQL](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.mysql.md) | A | N | PROTO |  |
| [Customer Datastore (n8n Training)](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.n8ntrainingcustomerdatastore.md) | B | X | SVC | n8n training sample, not a product; local fixtures instead. |
| [Customer Messenger (n8n Training)](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.n8ntrainingcustomermessenger.md) | B | X | SVC | n8n training sample, not a product; local fixtures instead. |
| [NASA](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.nasa.md) | B | N | SVC |  |
| [Netlify](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.netlify.md) | A | N | SVC |  |
| [Netscaler ADC](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.netscaleradc.md) | P | N | SVC |  |
| [Nextcloud](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.nextcloud.md) | A | N | SVC |  |
| [NocoDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.nocodb.md) | A | N | SVC |  |
| [Notion](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.notion.md) | A | P | NO | `core.notion`: search by title, get page properties, append blocks |
| [npm](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.npm.md) | B | N | SVC |  |
| [Odoo](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.odoo.md) | B | N | SVC |  |
| [Okta](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.okta.md) | B | N | SVC |  |
| [One Simple API](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.onesimpleapi.md) | B | N | SVC |  |
| [Onfleet](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.onfleet.md) | B | N | SVC |  |
| [OpenAI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.openai.md) | A | N | SVC |  |
| [OpenThesaurus](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.openthesaurus.md) | B | N | SVC |  |
| [OpenWeatherMap](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.openweathermap.md) | A | N | SVC |  |
| [Oracle Database](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.oracledb.md) | P | N | PROTO |  |
| [Oura](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.oura.md) | B | N | SVC |  |
| [Paddle](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.paddle.md) | B | N | SVC |  |
| [PagerDuty](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.pagerduty.md) | A | N | SVC |  |
| [PayPal](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.paypal.md) | A | N | SVC |  |
| [Peekalink](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.peekalink.md) | B | N | SVC |  |
| [Perplexity](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.perplexity.md) | A | N | SVC |  |
| [PhantomBuster](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.phantombuster.md) | B | N | SVC |  |
| [Philips Hue](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.philipshue.md) | B | N | SVC |  |
| [Pipedrive](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.pipedrive.md) | A | N | SVC |  |
| [Plivo](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.plivo.md) | B | N | SVC |  |
| [PostBin](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postbin.md) | B | N | SVC |  |
| [Postgres](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.postgres.md) | A | N | PROTO |  |
| [PostHog](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.posthog.md) | B | N | SVC |  |
| [ProfitWell](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.profitwell.md) | B | N | SVC |  |
| [Pushbullet](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.pushbullet.md) | A | N | SVC |  |
| [Pushcut](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.pushcut.md) | B | N | SVC |  |
| [Pushover](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.pushover.md) | A | N | SVC |  |
| [QuestDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.questdb.md) | P | N | PROTO |  |
| [Quick Base](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.quickbase.md) | B | N | SVC |  |
| [QuickBooks Online](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.quickbooks.md) | A | N | SVC |  |
| [QuickChart](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.quickchart.md) | A | N | SVC |  |
| [RabbitMQ](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.rabbitmq.md) | P | N | PROTO |  |
| [Raindrop](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.raindrop.md) | B | N | SVC |  |
| [Reddit](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.reddit.md) | A | N | SVC |  |
| [Redis](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.redis.md) | A | N | PROTO |  |
| [Rocket.Chat](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.rocketchat.md) | A | N | SVC |  |
| [Rundeck](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.rundeck.md) | B | N | SVC |  |
| [S3](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.s3.md) | A | N | SVC |  |
| [Salesforce](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.salesforce.md) | A | N | SF |  |
| [Salesmate](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.salesmate.md) | B | N | SVC |  |
| [SeaTable](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.seatable.md) | B | N | SVC |  |
| [SecurityScorecard](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.securityscorecard.md) | B | N | SVC |  |
| [Segment](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.segment.md) | B | N | SVC |  |
| [SendGrid](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.sendgrid.md) | A | N | SVC |  |
| [Sendy](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.sendy.md) | B | N | SVC |  |
| [Sentry.io](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.sentryio.md) | A | N | SVC |  |
| [ServiceNow](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.servicenow.md) | B | N | SVC |  |
| [seven](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.sms77.md) | B | N | SVC |  |
| [Shopify](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.shopify.md) | A | N | SH |  |
| [SIGNL4](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.signl4.md) | B | N | SVC |  |
| [Slack](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.slack.md) | A | P | SL | `core.slack`: send a message, channel history |
| [Snowflake](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.snowflake.md) | P | N | PROTO |  |
| [Splunk](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.splunk.md) | P | N | SVC |  |
| [Spotify](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.spotify.md) | A | N | SVC |  |
| [Stackby](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.stackby.md) | B | N | SVC |  |
| [Storyblok](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.storyblok.md) | B | N | SVC |  |
| [Strapi](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.strapi.md) | A | N | SVC |  |
| [Strava](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.strava.md) | B | N | SVC |  |
| [Stripe](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.stripe.md) | A | N | SVC |  |
| [Supabase](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.supabase.md) | A | N | SVC |  |
| [SyncroMSP](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.syncromsp.md) | B | N | SVC |  |
| [Taiga](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.taiga.md) | B | N | SVC |  |
| [Tapfiliate](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.tapfiliate.md) | B | N | SVC |  |
| [Telegram](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.telegram.md) | A | N | SVC |  |
| [TheHive](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.thehive.md) | B | N | SVC |  |
| [TheHive 5](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.thehive5.md) | B | N | SVC |  |
| [TimescaleDB](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.timescaledb.md) | P | N | PROTO |  |
| [Todoist](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.todoist.md) | A | N | SVC |  |
| [Travis CI](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.travisci.md) | B | N | SVC |  |
| [Trello](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.trello.md) | A | N | SVC |  |
| [Twake](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.twake.md) | B | N | SVC |  |
| [Twilio](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.twilio.md) | A | N | SVC |  |
| [Twist](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.twist.md) | B | N | SVC |  |
| [Unleashed Software](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.unleashedsoftware.md) | B | N | SVC |  |
| [UpLead](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.uplead.md) | B | N | SVC |  |
| [uProc](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.uproc.md) | B | N | SVC |  |
| [UptimeRobot](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.uptimerobot.md) | A | N | SVC |  |
| [urlscan.io](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.urlscanio.md) | B | N | SVC |  |
| [Venafi TLS Protect Cloud](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.venafitlsprotectcloud.md) | B | N | SVC |  |
| [Venafi TLS Protect Datacenter](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.venafitlsprotectdatacenter.md) | B | N | SVC |  |
| [Vero](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.vero.md) | B | N | SVC |  |
| [Vonage](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.vonage.md) | B | N | SVC |  |
| [Webflow](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.webflow.md) | A | N | SVC |  |
| [Wekan](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.wekan.md) | B | N | SVC |  |
| [WhatsApp Business Cloud](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.whatsapp.md) | A | N | META |  |
| [Wise](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.wise.md) | B | N | SVC |  |
| [WooCommerce](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.woocommerce.md) | A | N | SVC |  |
| [WordPress](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.wordpress.md) | A | N | SVC |  |
| [X (Formerly Twitter)](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.twitter.md) | A | N | SVC |  |
| [Xero](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.xero.md) | A | N | SVC |  |
| [Yourls](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.yourls.md) | B | N | SVC |  |
| [YouTube](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.youtube.md) | A | N | SVC |  |
| [Zammad](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.zammad.md) | B | N | SVC |  |
| [Zendesk](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.zendesk.md) | A | N | SVC |  |
| [Zoho CRM](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.zohocrm.md) | A | N | SVC |  |
| [Zoom](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.zoom.md) | A | N | SVC |  |
| [Zulip](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.zulip.md) | B | N | SVC |  |

## App trigger nodes (91)

All N: an implemented action never counts as its trigger. Every row also needs the trigger lifecycle work above.

| Node | Priority | State | Auth gate |
| --- | --- | --- | --- |
| [ActiveCampaign Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.activecampaigntrigger.md) | B | N | SVC |
| [Acuity Scheduling Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.acuityschedulingtrigger.md) | B | N | SVC |
| [Affinity Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.affinitytrigger.md) | B | N | SVC |
| [Airtable Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.airtabletrigger.md) | A | N | SVC |
| [AMQP Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.amqptrigger.md) | B | N | PROTO |
| [Asana Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.asanatrigger.md) | A | N | SVC |
| [Autopilot Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.autopilottrigger.md) | B | N | SVC |
| [AWS SNS Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.awssnstrigger.md) | B | N | AWS |
| [Bitbucket Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.bitbuckettrigger.md) | B | N | SVC |
| [Box Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.boxtrigger.md) | B | N | SVC |
| [Brevo Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.brevotrigger.md) | A | N | SVC |
| [Calendly Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.calendlytrigger.md) | A | N | SVC |
| [Cal Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.caltrigger.md) | B | N | SVC |
| [Chargebee Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.chargebeetrigger.md) | B | N | SVC |
| [ClickUp Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.clickuptrigger.md) | A | N | SVC |
| [Clockify Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.clockifytrigger.md) | B | N | SVC |
| [ConvertKit Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.convertkittrigger.md) | B | N | SVC |
| [Copper Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.coppertrigger.md) | B | N | SVC |
| [Customer.io Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.customeriotrigger.md) | B | N | SVC |
| [Databricks Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.databrickstrigger.md) | P | N | SVC |
| [Emelia Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.emeliatrigger.md) | B | N | SVC |
| [Eventbrite Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.eventbritetrigger.md) | B | N | SVC |
| [Facebook Lead Ads Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.facebookleadadstrigger.md) | B | N | META |
| [Facebook Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.facebooktrigger.md) | B | N | META |
| [Figma Trigger (Beta)](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.figmatrigger.md) | B | N | SVC |
| [Flow Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.flowtrigger.md) | B | N | SVC |
| [Form.io Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.formiotrigger.md) | B | N | SVC |
| [Formstack Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.formstacktrigger.md) | B | N | SVC |
| [GetResponse Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.getresponsetrigger.md) | B | N | SVC |
| [GitHub Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.githubtrigger.md) | A | N | GH |
| [GitLab Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gitlabtrigger.md) | A | N | SVC |
| [Gmail Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gmailtrigger.md) | A | N | G |
| [Google Calendar Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.googlecalendartrigger.md) | A | N | G |
| [Google Drive Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.googledrivetrigger.md) | A | N | G |
| [Google Business Profile Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.googlebusinessprofiletrigger.md) | A | N | G |
| [Google Sheets Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.googlesheetstrigger.md) | A | N | G |
| [Gumroad Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.gumroadtrigger.md) | B | N | SVC |
| [Help Scout Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.helpscouttrigger.md) | B | N | SVC |
| [HubSpot Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.hubspottrigger.md) | A | N | SVC |
| [Invoice Ninja Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.invoiceninjatrigger.md) | B | N | SVC |
| [Jira Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.jiratrigger.md) | B | N | SVC |
| [Jotform Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.jotformtrigger.md) | A | N | SVC |
| [Kafka Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.kafkatrigger.md) | P | N | PROTO |
| [Keap Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.keaptrigger.md) | B | N | SVC |
| [KoboToolbox Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.kobotoolboxtrigger.md) | B | N | SVC |
| [Lemlist Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.lemlisttrigger.md) | B | N | SVC |
| [Linear Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.lineartrigger.md) | A | N | SVC |
| [LoneScale Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.lonescaletrigger.md) | B | N | SVC |
| [Mailchimp Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.mailchimptrigger.md) | A | N | SVC |
| [MailerLite Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.mailerlitetrigger.md) | A | N | SVC |
| [Mailjet Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.mailjettrigger.md) | B | N | SVC |
| [Mautic Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.mautictrigger.md) | B | N | SVC |
| [Microsoft OneDrive Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.microsoftonedrivetrigger.md) | A | N | MS |
| [Microsoft Outlook Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.microsoftoutlooktrigger.md) | A | N | MS |
| [Microsoft SharePoint Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.microsoftsharepointtrigger.md) | B | N | MS |
| [Microsoft Teams Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.microsoftteamstrigger.md) | A | N | MS |
| [MQTT Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.mqtttrigger.md) | P | N | PROTO |
| [Netlify Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.netlifytrigger.md) | A | N | SVC |
| [Notion Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.notiontrigger.md) | A | N | NO |
| [Onfleet Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.onfleettrigger.md) | B | N | SVC |
| [PayPal Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.paypaltrigger.md) | A | N | SVC |
| [Pipedrive Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.pipedrivetrigger.md) | A | N | SVC |
| [Postgres Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.postgrestrigger.md) | A | N | PROTO |
| [Postmark Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.postmarktrigger.md) | B | N | SVC |
| [Pushcut Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.pushcuttrigger.md) | B | N | SVC |
| [RabbitMQ Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.rabbitmqtrigger.md) | P | N | PROTO |
| [Redis Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.redistrigger.md) | A | N | PROTO |
| [Salesforce Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.salesforcetrigger.md) | A | N | SF |
| [SeaTable Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.seatabletrigger.md) | B | N | SVC |
| [Shopify Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.shopifytrigger.md) | A | N | SH |
| [Slack Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.slacktrigger.md) | A | N | SL |
| [Strava Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.stravatrigger.md) | B | N | SVC |
| [Stripe Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.stripetrigger.md) | A | N | SVC |
| [SurveyMonkey Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.surveymonkeytrigger.md) | B | N | SVC |
| [Taiga Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.taigatrigger.md) | B | N | SVC |
| [Telegram Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.telegramtrigger.md) | A | N | SVC |
| [TheHive 5 Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.thehive5trigger.md) | B | N | SVC |
| [TheHive Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.thehivetrigger.md) | B | N | SVC |
| [Toggl Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.toggltrigger.md) | B | N | SVC |
| [Trello Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.trellotrigger.md) | A | N | SVC |
| [Twilio Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.twiliotrigger.md) | A | N | SVC |
| [Typeform Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.typeformtrigger.md) | A | N | SVC |
| [Venafi TLS Protect Cloud Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.venafitlsprotectcloudtrigger.md) | B | N | SVC |
| [Webex by Cisco Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.ciscowebextrigger.md) | B | N | SVC |
| [Webflow Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.webflowtrigger.md) | A | N | SVC |
| [WhatsApp Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.whatsapptrigger.md) | B | N | META |
| [Wise Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.wisetrigger.md) | B | N | SVC |
| [WooCommerce Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.woocommercetrigger.md) | A | N | SVC |
| [Workable Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.workabletrigger.md) | B | N | SVC |
| [Wufoo Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.wufootrigger.md) | B | N | SVC |
| [Zendesk Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.zendesktrigger.md) | A | N | SVC |

## Credential guides (322)

Every guide root of the index, **not** that many Smart Knife credential types. P = a generic mechanism or a recipe covers
part of it; N = no named support. None is provider-live verified.

| Guide | Local support |
| --- | --- |
| [Action Network credentials](https://docs.n8n.io/integrations/builtin/credentials/actionnetwork.md) | N |
| [ActiveCampaign credentials](https://docs.n8n.io/integrations/builtin/credentials/activecampaign.md) | N |
| [Acuity Scheduling credentials](https://docs.n8n.io/integrations/builtin/credentials/acuityscheduling.md) | N |
| [Adalo credentials](https://docs.n8n.io/integrations/builtin/credentials/adalo.md) | N |
| [Affinity credentials](https://docs.n8n.io/integrations/builtin/credentials/affinity.md) | N |
| [Agile CRM credentials](https://docs.n8n.io/integrations/builtin/credentials/agilecrm.md) | N |
| [Airtable credentials](https://docs.n8n.io/integrations/builtin/credentials/airtable.md) | P |
| [Airtop credentials](https://docs.n8n.io/integrations/builtin/credentials/airtop.md) | N |
| [Qwen Cloud credentials](https://docs.n8n.io/integrations/builtin/credentials/alibaba.md) | N |
| [AlienVault credentials](https://docs.n8n.io/integrations/builtin/credentials/alienvault.md) | N |
| [AMQP credentials](https://docs.n8n.io/integrations/builtin/credentials/amqp.md) | N |
| [Anthropic credentials](https://docs.n8n.io/integrations/builtin/credentials/anthropic.md) | N |
| [APITemplate.io credentials](https://docs.n8n.io/integrations/builtin/credentials/apitemplateio.md) | N |
| [Asana credentials](https://docs.n8n.io/integrations/builtin/credentials/asana.md) | N |
| [Atlassian credentials](https://docs.n8n.io/integrations/builtin/credentials/atlassian.md) | N |
| [Auth0 Management credentials](https://docs.n8n.io/integrations/builtin/credentials/auth0management.md) | N |
| [Autopilot credentials](https://docs.n8n.io/integrations/builtin/credentials/autopilot.md) | N |
| [AWS credentials](https://docs.n8n.io/integrations/builtin/credentials/aws.md) | N |
| [Microsoft Foundry credentials](https://docs.n8n.io/integrations/builtin/credentials/azureopenai.md) | N |
| [Azure Cosmos DB credentials](https://docs.n8n.io/integrations/builtin/credentials/azurecosmosdb.md) | N |
| [Azure AI Search credentials](https://docs.n8n.io/integrations/builtin/credentials/azureaisearch.md) | N |
| [Azure Storage credentials](https://docs.n8n.io/integrations/builtin/credentials/azurestorage.md) | N |
| [BambooHR credentials](https://docs.n8n.io/integrations/builtin/credentials/bamboohr.md) | N |
| [Bannerbear credentials](https://docs.n8n.io/integrations/builtin/credentials/bannerbear.md) | N |
| [Baserow credentials](https://docs.n8n.io/integrations/builtin/credentials/baserow.md) | N |
| [Beeminder credentials](https://docs.n8n.io/integrations/builtin/credentials/beeminder.md) | N |
| [Bitbucket credentials](https://docs.n8n.io/integrations/builtin/credentials/bitbucket.md) | N |
| [Bitly credentials](https://docs.n8n.io/integrations/builtin/credentials/bitly.md) | N |
| [Bitwarden credentials](https://docs.n8n.io/integrations/builtin/credentials/bitwarden.md) | N |
| [Box credentials](https://docs.n8n.io/integrations/builtin/credentials/box.md) | N |
| [Brandfetch credentials](https://docs.n8n.io/integrations/builtin/credentials/brandfetch.md) | N |
| [Brave Search credentials](https://docs.n8n.io/integrations/builtin/credentials/bravesearch.md) | N |
| [Brevo credentials](https://docs.n8n.io/integrations/builtin/credentials/brevo.md) | N |
| [Bubble credentials](https://docs.n8n.io/integrations/builtin/credentials/bubble.md) | N |
| [Cal.com credentials](https://docs.n8n.io/integrations/builtin/credentials/cal.md) | N |
| [Calendly credentials](https://docs.n8n.io/integrations/builtin/credentials/calendly.md) | N |
| [Carbon Black credentials](https://docs.n8n.io/integrations/builtin/credentials/carbonblack.md) | N |
| [Chargebee credentials](https://docs.n8n.io/integrations/builtin/credentials/chargebee.md) | N |
| [CircleCI credentials](https://docs.n8n.io/integrations/builtin/credentials/circleci.md) | N |
| [Cisco Meraki credentials](https://docs.n8n.io/integrations/builtin/credentials/ciscomeraki.md) | N |
| [Cisco Secure Endpoint credentials](https://docs.n8n.io/integrations/builtin/credentials/ciscosecureendpoint.md) | N |
| [Cisco Umbrella credentials](https://docs.n8n.io/integrations/builtin/credentials/ciscoumbrella.md) | N |
| [Clearbit credentials](https://docs.n8n.io/integrations/builtin/credentials/clearbit.md) | N |
| [ClickUp credentials](https://docs.n8n.io/integrations/builtin/credentials/clickup.md) | N |
| [Clockify credentials](https://docs.n8n.io/integrations/builtin/credentials/clockify.md) | N |
| [Cloudflare credentials](https://docs.n8n.io/integrations/builtin/credentials/cloudflare.md) | N |
| [Cockpit credentials](https://docs.n8n.io/integrations/builtin/credentials/cockpit.md) | N |
| [Coda credentials](https://docs.n8n.io/integrations/builtin/credentials/coda.md) | N |
| [Cohere credentials](https://docs.n8n.io/integrations/builtin/credentials/cohere.md) | N |
| [Confluence credentials](https://docs.n8n.io/integrations/builtin/credentials/confluence.md) | N |
| [Contentful credentials](https://docs.n8n.io/integrations/builtin/credentials/contentful.md) | N |
| [ConvertAPI credentials](https://docs.n8n.io/integrations/builtin/credentials/convertapi.md) | N |
| [ConvertKit credentials](https://docs.n8n.io/integrations/builtin/credentials/convertkit.md) | N |
| [Copper credentials](https://docs.n8n.io/integrations/builtin/credentials/copper.md) | N |
| [Cortex credentials](https://docs.n8n.io/integrations/builtin/credentials/cortex.md) | N |
| [CrateDB credentials](https://docs.n8n.io/integrations/builtin/credentials/cratedb.md) | N |
| [CrowdStrike credentials](https://docs.n8n.io/integrations/builtin/credentials/crowdstrike.md) | N |
| [Crypto credentials](https://docs.n8n.io/integrations/builtin/credentials/crypto.md) | N |
| [Customer.io credentials](https://docs.n8n.io/integrations/builtin/credentials/customerio.md) | N |
| [Databricks credentials](https://docs.n8n.io/integrations/builtin/credentials/databricks.md) | N |
| [Datadog credentials](https://docs.n8n.io/integrations/builtin/credentials/datadog.md) | N |
| [Daytona credentials](https://docs.n8n.io/integrations/builtin/credentials/daytona.md) | N |
| [DeepL credentials](https://docs.n8n.io/integrations/builtin/credentials/deepl.md) | N |
| [DeepSeek credentials](https://docs.n8n.io/integrations/builtin/credentials/deepseek.md) | P |
| [Demio credentials](https://docs.n8n.io/integrations/builtin/credentials/demio.md) | N |
| [DFIR-IRIS credentials](https://docs.n8n.io/integrations/builtin/credentials/dfiriris.md) | N |
| [DHL credentials](https://docs.n8n.io/integrations/builtin/credentials/dhl.md) | N |
| [Discord credentials](https://docs.n8n.io/integrations/builtin/credentials/discord.md) | P |
| [Discourse credentials](https://docs.n8n.io/integrations/builtin/credentials/discourse.md) | N |
| [Disqus credentials](https://docs.n8n.io/integrations/builtin/credentials/disqus.md) | N |
| [Drift credentials](https://docs.n8n.io/integrations/builtin/credentials/drift.md) | N |
| [Dropbox credentials](https://docs.n8n.io/integrations/builtin/credentials/dropbox.md) | N |
| [Dropcontact credentials](https://docs.n8n.io/integrations/builtin/credentials/dropcontact.md) | N |
| [Dynatrace credentials](https://docs.n8n.io/integrations/builtin/credentials/dynatrace.md) | N |
| [E-goi credentials](https://docs.n8n.io/integrations/builtin/credentials/egoi.md) | N |
| [Elasticsearch credentials](https://docs.n8n.io/integrations/builtin/credentials/elasticsearch.md) | N |
| [Elastic Security credentials](https://docs.n8n.io/integrations/builtin/credentials/elasticsecurity.md) | N |
| [Emelia credentials](https://docs.n8n.io/integrations/builtin/credentials/emelia.md) | N |
| [ERPNext credentials](https://docs.n8n.io/integrations/builtin/credentials/erpnext.md) | N |
| [Eventbrite credentials](https://docs.n8n.io/integrations/builtin/credentials/eventbrite.md) | N |
| [F5 Big-IP credentials](https://docs.n8n.io/integrations/builtin/credentials/f5bigip.md) | N |
| [Facebook App credentials](https://docs.n8n.io/integrations/builtin/credentials/facebookapp.md) | N |
| [Facebook Graph API credentials](https://docs.n8n.io/integrations/builtin/credentials/facebookgraph.md) | P |
| [Facebook Lead Ads credentials](https://docs.n8n.io/integrations/builtin/credentials/facebookleadads.md) | N |
| [Figma credentials](https://docs.n8n.io/integrations/builtin/credentials/figma.md) | N |
| [FileMaker credentials](https://docs.n8n.io/integrations/builtin/credentials/filemaker.md) | N |
| [Filescan credentials](https://docs.n8n.io/integrations/builtin/credentials/filescan.md) | N |
| [Flow credentials](https://docs.n8n.io/integrations/builtin/credentials/flow.md) | N |
| [Form.io Trigger credentials](https://docs.n8n.io/integrations/builtin/credentials/formiotrigger.md) | N |
| [Formstack Trigger credentials](https://docs.n8n.io/integrations/builtin/credentials/formstacktrigger.md) | N |
| [Fortinet FortiGate credentials](https://docs.n8n.io/integrations/builtin/credentials/fortigate.md) | N |
| [Freshdesk credentials](https://docs.n8n.io/integrations/builtin/credentials/freshdesk.md) | N |
| [Freshservice credentials](https://docs.n8n.io/integrations/builtin/credentials/freshservice.md) | N |
| [Freshworks CRM credentials](https://docs.n8n.io/integrations/builtin/credentials/freshworkscrm.md) | N |
| [FTP credentials](https://docs.n8n.io/integrations/builtin/credentials/ftp.md) | N |
| [GetResponse credentials](https://docs.n8n.io/integrations/builtin/credentials/getresponse.md) | N |
| [Ghost credentials](https://docs.n8n.io/integrations/builtin/credentials/ghost.md) | N |
| [Git credentials](https://docs.n8n.io/integrations/builtin/credentials/git.md) | N |
| [GitHub credentials](https://docs.n8n.io/integrations/builtin/credentials/github.md) | P |
| [GitLab credentials](https://docs.n8n.io/integrations/builtin/credentials/gitlab.md) | P |
| [Gong credentials](https://docs.n8n.io/integrations/builtin/credentials/gong.md) | N |
| [Google](https://docs.n8n.io/integrations/builtin/credentials/google.md) | P |
| [Google Gemini(PaLM) credentials](https://docs.n8n.io/integrations/builtin/credentials/googleai.md) | N |
| [Google Vertex AI credentials](https://docs.n8n.io/integrations/builtin/credentials/googlevertexai.md) | N |
| [Gotify credentials](https://docs.n8n.io/integrations/builtin/credentials/gotify.md) | N |
| [GoToWebinar credentials](https://docs.n8n.io/integrations/builtin/credentials/gotowebinar.md) | N |
| [Grafana credentials](https://docs.n8n.io/integrations/builtin/credentials/grafana.md) | N |
| [Grist credentials](https://docs.n8n.io/integrations/builtin/credentials/grist.md) | N |
| [Groq credentials](https://docs.n8n.io/integrations/builtin/credentials/groq.md) | P |
| [Gumroad credentials](https://docs.n8n.io/integrations/builtin/credentials/gumroad.md) | N |
| [HaloPSA credentials](https://docs.n8n.io/integrations/builtin/credentials/halopsa.md) | N |
| [Harvest credentials](https://docs.n8n.io/integrations/builtin/credentials/harvest.md) | N |
| [Help Scout credentials](https://docs.n8n.io/integrations/builtin/credentials/helpscout.md) | N |
| [HighLevel credentials](https://docs.n8n.io/integrations/builtin/credentials/highlevel.md) | N |
| [Home Assistant credentials](https://docs.n8n.io/integrations/builtin/credentials/homeassistant.md) | N |
| [HTTP Request credentials](https://docs.n8n.io/integrations/builtin/credentials/httprequest.md) | P |
| [HubSpot credentials](https://docs.n8n.io/integrations/builtin/credentials/hubspot.md) | P |
| [Hugging Face credentials](https://docs.n8n.io/integrations/builtin/credentials/huggingface.md) | N |
| [Humantic AI credentials](https://docs.n8n.io/integrations/builtin/credentials/humanticai.md) | N |
| [Hunter credentials](https://docs.n8n.io/integrations/builtin/credentials/hunter.md) | N |
| [Hybrid Analysis credentials](https://docs.n8n.io/integrations/builtin/credentials/hybridanalysis.md) | N |
| [IMAP](https://docs.n8n.io/integrations/builtin/credentials/imap.md) | N |
| [Imperva WAF credentials](https://docs.n8n.io/integrations/builtin/credentials/impervawaf.md) | N |
| [Intercom credentials](https://docs.n8n.io/integrations/builtin/credentials/intercom.md) | N |
| [Invoice Ninja credentials](https://docs.n8n.io/integrations/builtin/credentials/invoiceninja.md) | N |
| [Iterable credentials](https://docs.n8n.io/integrations/builtin/credentials/iterable.md) | N |
| [Jenkins credentials](https://docs.n8n.io/integrations/builtin/credentials/jenkins.md) | N |
| [Jina AI credentials](https://docs.n8n.io/integrations/builtin/credentials/jinaai.md) | N |
| [Jira credentials](https://docs.n8n.io/integrations/builtin/credentials/jira.md) | N |
| [Jotform credentials](https://docs.n8n.io/integrations/builtin/credentials/jotform.md) | N |
| [JWT credentials](https://docs.n8n.io/integrations/builtin/credentials/jwt.md) | P |
| [Kafka credentials](https://docs.n8n.io/integrations/builtin/credentials/kafka.md) | N |
| [Keap credentials](https://docs.n8n.io/integrations/builtin/credentials/keap.md) | N |
| [Kibana credentials](https://docs.n8n.io/integrations/builtin/credentials/kibana.md) | N |
| [Kitemaker credentials](https://docs.n8n.io/integrations/builtin/credentials/kitemaker.md) | N |
| [KoboToolbox credentials](https://docs.n8n.io/integrations/builtin/credentials/kobotoolbox.md) | N |
| [LDAP credentials](https://docs.n8n.io/integrations/builtin/credentials/ldap.md) | N |
| [Lemlist credentials](https://docs.n8n.io/integrations/builtin/credentials/lemlist.md) | N |
| [Lemonade credentials](https://docs.n8n.io/integrations/builtin/credentials/lemonade.md) | N |
| [Line credentials](https://docs.n8n.io/integrations/builtin/credentials/line.md) | N |
| [Linear credentials](https://docs.n8n.io/integrations/builtin/credentials/linear.md) | N |
| [LingvaNex credentials](https://docs.n8n.io/integrations/builtin/credentials/lingvanex.md) | N |
| [LinkedIn credentials](https://docs.n8n.io/integrations/builtin/credentials/linkedin.md) | N |
| [LoneScale credentials](https://docs.n8n.io/integrations/builtin/credentials/lonescale.md) | N |
| [Magento 2 credentials](https://docs.n8n.io/integrations/builtin/credentials/magento2.md) | N |
| [Mailcheck credentials](https://docs.n8n.io/integrations/builtin/credentials/mailcheck.md) | N |
| [Mailchimp credentials](https://docs.n8n.io/integrations/builtin/credentials/mailchimp.md) | N |
| [MailerLite credentials](https://docs.n8n.io/integrations/builtin/credentials/mailerlite.md) | N |
| [Mailgun credentials](https://docs.n8n.io/integrations/builtin/credentials/mailgun.md) | N |
| [Mailjet credentials](https://docs.n8n.io/integrations/builtin/credentials/mailjet.md) | N |
| [Malcore credentials](https://docs.n8n.io/integrations/builtin/credentials/malcore.md) | N |
| [Mandrill credentials](https://docs.n8n.io/integrations/builtin/credentials/mandrill.md) | N |
| [Marketstack credentials](https://docs.n8n.io/integrations/builtin/credentials/marketstack.md) | N |
| [Matrix credentials](https://docs.n8n.io/integrations/builtin/credentials/matrix.md) | N |
| [Mattermost credentials](https://docs.n8n.io/integrations/builtin/credentials/mattermost.md) | N |
| [Mautic credentials](https://docs.n8n.io/integrations/builtin/credentials/mautic.md) | N |
| [MCP credentials](https://docs.n8n.io/integrations/builtin/credentials/mcp.md) | N |
| [Medium credentials](https://docs.n8n.io/integrations/builtin/credentials/medium.md) | N |
| [MessageBird credentials](https://docs.n8n.io/integrations/builtin/credentials/messagebird.md) | N |
| [Metabase credentials](https://docs.n8n.io/integrations/builtin/credentials/metabase.md) | N |
| [Microsoft credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoft.md) | P |
| [Microsoft Azure Monitor credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftazuremonitor.md) | N |
| [Microsoft Dataverse credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftdataverse.md) | N |
| [Microsoft Entra ID credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftentra.md) | N |
| [Microsoft Entra Service Principal credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftentraserviceprincipal.md) | N |
| [Provision a SharePoint app registration with the Azure CLI](https://docs.n8n.io/integrations/builtin/credentials/microsoftentraserviceprincipal-sharepoint.md) | N |
| [Microsoft SQL credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftsql.md) | N |
| [Microsoft Agent 365 credentials](https://docs.n8n.io/integrations/builtin/credentials/microsoftagent365.md) | N |
| [Milvus credentials](https://docs.n8n.io/integrations/builtin/credentials/milvus.md) | N |
| [Mindee credentials](https://docs.n8n.io/integrations/builtin/credentials/mindee.md) | N |
| [Miro credentials](https://docs.n8n.io/integrations/builtin/credentials/miro.md) | N |
| [MISP credentials](https://docs.n8n.io/integrations/builtin/credentials/misp.md) | N |
| [Mist credentials](https://docs.n8n.io/integrations/builtin/credentials/mist.md) | N |
| [MiniMax credentials](https://docs.n8n.io/integrations/builtin/credentials/minimax.md) | N |
| [Mistral Cloud credentials](https://docs.n8n.io/integrations/builtin/credentials/mistral.md) | P |
| [Mocean credentials](https://docs.n8n.io/integrations/builtin/credentials/mocean.md) | N |
| [monday.com credentials](https://docs.n8n.io/integrations/builtin/credentials/mondaycom.md) | N |
| [MongoDB credentials](https://docs.n8n.io/integrations/builtin/credentials/mongodb.md) | N |
| [Monica CRM credentials](https://docs.n8n.io/integrations/builtin/credentials/monicacrm.md) | N |
| [Moonshot credentials](https://docs.n8n.io/integrations/builtin/credentials/moonshot.md) | N |
| [Motorhead credentials](https://docs.n8n.io/integrations/builtin/credentials/motorhead.md) | N |
| [MQTT credentials](https://docs.n8n.io/integrations/builtin/credentials/mqtt.md) | N |
| [MSG91 credentials](https://docs.n8n.io/integrations/builtin/credentials/msg91.md) | N |
| [MySQL credentials](https://docs.n8n.io/integrations/builtin/credentials/mysql.md) | N |
| [NASA credentials](https://docs.n8n.io/integrations/builtin/credentials/nasa.md) | N |
| [Netlify credentials](https://docs.n8n.io/integrations/builtin/credentials/netlify.md) | N |
| [Netscaler ADC credentials](https://docs.n8n.io/integrations/builtin/credentials/netscaleradc.md) | N |
| [Nextcloud credentials](https://docs.n8n.io/integrations/builtin/credentials/nextcloud.md) | N |
| [NocoDB credentials](https://docs.n8n.io/integrations/builtin/credentials/nocodb.md) | N |
| [Notion credentials](https://docs.n8n.io/integrations/builtin/credentials/notion.md) | P |
| [npm credentials](https://docs.n8n.io/integrations/builtin/credentials/npm.md) | N |
| [NVIDIA Nemotron credentials](https://docs.n8n.io/integrations/builtin/credentials/nvidia.md) | N |
| [Odoo credentials](https://docs.n8n.io/integrations/builtin/credentials/odoo.md) | N |
| [Okta credentials](https://docs.n8n.io/integrations/builtin/credentials/okta.md) | N |
| [Ollama credentials](https://docs.n8n.io/integrations/builtin/credentials/ollama.md) | P |
| [One Simple API credentials](https://docs.n8n.io/integrations/builtin/credentials/onesimpleapi.md) | N |
| [Onfleet credentials](https://docs.n8n.io/integrations/builtin/credentials/onfleet.md) | N |
| [OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai.md) | P |
| [OpenCTI credentials](https://docs.n8n.io/integrations/builtin/credentials/opencti.md) | N |
| [OpenRouter credentials](https://docs.n8n.io/integrations/builtin/credentials/openrouter.md) | P |
| [OpenWeatherMap credentials](https://docs.n8n.io/integrations/builtin/credentials/openweathermap.md) | N |
| [Oracle Database credentials](https://docs.n8n.io/integrations/builtin/credentials/oracledb.md) | N |
| [Oura credentials](https://docs.n8n.io/integrations/builtin/credentials/oura.md) | N |
| [Paddle credentials](https://docs.n8n.io/integrations/builtin/credentials/paddle.md) | N |
| [PagerDuty credentials](https://docs.n8n.io/integrations/builtin/credentials/pagerduty.md) | N |
| [PayPal credentials](https://docs.n8n.io/integrations/builtin/credentials/paypal.md) | N |
| [Peekalink credentials](https://docs.n8n.io/integrations/builtin/credentials/peekalink.md) | N |
| [Perplexity credentials](https://docs.n8n.io/integrations/builtin/credentials/perplexity.md) | N |
| [PhantomBuster credentials](https://docs.n8n.io/integrations/builtin/credentials/phantombuster.md) | N |
| [Philips Hue credentials](https://docs.n8n.io/integrations/builtin/credentials/philipshue.md) | N |
| [Chroma credentials](https://docs.n8n.io/integrations/builtin/credentials/chroma.md) | N |
| [Pinecone credentials](https://docs.n8n.io/integrations/builtin/credentials/pinecone.md) | N |
| [Pipedrive credentials](https://docs.n8n.io/integrations/builtin/credentials/pipedrive.md) | N |
| [Plivo credentials](https://docs.n8n.io/integrations/builtin/credentials/plivo.md) | N |
| [Postgres credentials](https://docs.n8n.io/integrations/builtin/credentials/postgres.md) | N |
| [PostHog credentials](https://docs.n8n.io/integrations/builtin/credentials/posthog.md) | N |
| [Postmark credentials](https://docs.n8n.io/integrations/builtin/credentials/postmark.md) | N |
| [ProfitWell credentials](https://docs.n8n.io/integrations/builtin/credentials/profitwell.md) | N |
| [Pushbullet credentials](https://docs.n8n.io/integrations/builtin/credentials/pushbullet.md) | N |
| [Pushcut credentials](https://docs.n8n.io/integrations/builtin/credentials/pushcut.md) | N |
| [Pushover credentials](https://docs.n8n.io/integrations/builtin/credentials/pushover.md) | N |
| [QRadar credentials](https://docs.n8n.io/integrations/builtin/credentials/qradar.md) | N |
| [Qdrant credentials](https://docs.n8n.io/integrations/builtin/credentials/qdrant.md) | N |
| [Qualys credentials](https://docs.n8n.io/integrations/builtin/credentials/qualys.md) | N |
| [QuestDB credentials](https://docs.n8n.io/integrations/builtin/credentials/questdb.md) | N |
| [Quick Base credentials](https://docs.n8n.io/integrations/builtin/credentials/quickbase.md) | N |
| [QuickBooks credentials](https://docs.n8n.io/integrations/builtin/credentials/quickbooks.md) | N |
| [RabbitMQ credentials](https://docs.n8n.io/integrations/builtin/credentials/rabbitmq.md) | N |
| [Raindrop credentials](https://docs.n8n.io/integrations/builtin/credentials/raindrop.md) | N |
| [Rapid7 InsightVM credentials](https://docs.n8n.io/integrations/builtin/credentials/rapid7insightvm.md) | N |
| [Recorded Future credentials](https://docs.n8n.io/integrations/builtin/credentials/recordedfuture.md) | N |
| [Reddit credentials](https://docs.n8n.io/integrations/builtin/credentials/reddit.md) | N |
| [Redis credentials](https://docs.n8n.io/integrations/builtin/credentials/redis.md) | N |
| [Rocket.Chat credentials](https://docs.n8n.io/integrations/builtin/credentials/rocketchat.md) | N |
| [Rundeck credentials](https://docs.n8n.io/integrations/builtin/credentials/rundeck.md) | N |
| [S3 credentials](https://docs.n8n.io/integrations/builtin/credentials/s3.md) | N |
| [Salesforce credentials](https://docs.n8n.io/integrations/builtin/credentials/salesforce.md) | N |
| [Salesmate credentials](https://docs.n8n.io/integrations/builtin/credentials/salesmate.md) | N |
| [Schema Registry credentials](https://docs.n8n.io/integrations/builtin/credentials/schemaregistry.md) | N |
| [SearXNG credentials](https://docs.n8n.io/integrations/builtin/credentials/searxng.md) | N |
| [SeaTable credentials](https://docs.n8n.io/integrations/builtin/credentials/seatable.md) | N |
| [SecurityScorecard credentials](https://docs.n8n.io/integrations/builtin/credentials/securityscorecard.md) | N |
| [Segment credentials](https://docs.n8n.io/integrations/builtin/credentials/segment.md) | N |
| [Sekoia credentials](https://docs.n8n.io/integrations/builtin/credentials/sekoia.md) | N |
| [Send Email](https://docs.n8n.io/integrations/builtin/credentials/send-email.md) | N |
| [SendGrid credentials](https://docs.n8n.io/integrations/builtin/credentials/sendgrid.md) | N |
| [Sendy credentials](https://docs.n8n.io/integrations/builtin/credentials/sendy.md) | N |
| [Sentry.io credentials](https://docs.n8n.io/integrations/builtin/credentials/sentryio.md) | N |
| [Serp credentials](https://docs.n8n.io/integrations/builtin/credentials/serp.md) | N |
| [ServiceNow credentials](https://docs.n8n.io/integrations/builtin/credentials/servicenow.md) | N |
| [seven credentials](https://docs.n8n.io/integrations/builtin/credentials/sms77.md) | N |
| [Shopify credentials](https://docs.n8n.io/integrations/builtin/credentials/shopify.md) | N |
| [Shuffler credentials](https://docs.n8n.io/integrations/builtin/credentials/shuffler.md) | N |
| [SIGNL4 credentials](https://docs.n8n.io/integrations/builtin/credentials/signl4.md) | N |
| [Slack credentials](https://docs.n8n.io/integrations/builtin/credentials/slack.md) | P |
| [Snowflake credentials](https://docs.n8n.io/integrations/builtin/credentials/snowflake.md) | N |
| [SolarWinds IPAM credentials](https://docs.n8n.io/integrations/builtin/credentials/solarwindsipam.md) | N |
| [SolarWinds Observability SaaS credentials](https://docs.n8n.io/integrations/builtin/credentials/solarwindsobservability.md) | N |
| [Splunk credentials](https://docs.n8n.io/integrations/builtin/credentials/splunk.md) | N |
| [Spotify credentials](https://docs.n8n.io/integrations/builtin/credentials/spotify.md) | N |
| [SSH credentials](https://docs.n8n.io/integrations/builtin/credentials/ssh.md) | N |
| [Stackby credentials](https://docs.n8n.io/integrations/builtin/credentials/stackby.md) | N |
| [Storyblok credentials](https://docs.n8n.io/integrations/builtin/credentials/storyblok.md) | N |
| [Strapi credentials](https://docs.n8n.io/integrations/builtin/credentials/strapi.md) | N |
| [Strava credentials](https://docs.n8n.io/integrations/builtin/credentials/strava.md) | N |
| [Stripe credentials](https://docs.n8n.io/integrations/builtin/credentials/stripe.md) | P |
| [Supabase credentials](https://docs.n8n.io/integrations/builtin/credentials/supabase.md) | N |
| [SurveyMonkey credentials](https://docs.n8n.io/integrations/builtin/credentials/surveymonkey.md) | N |
| [SyncroMSP credentials](https://docs.n8n.io/integrations/builtin/credentials/syncromsp.md) | N |
| [Sysdig credentials](https://docs.n8n.io/integrations/builtin/credentials/sysdig.md) | N |
| [Taiga credentials](https://docs.n8n.io/integrations/builtin/credentials/taiga.md) | N |
| [Tapfiliate credentials](https://docs.n8n.io/integrations/builtin/credentials/tapfiliate.md) | N |
| [Telegram credentials](https://docs.n8n.io/integrations/builtin/credentials/telegram.md) | N |
| [TheHive credentials](https://docs.n8n.io/integrations/builtin/credentials/thehive.md) | N |
| [TheHive 5 credentials](https://docs.n8n.io/integrations/builtin/credentials/thehive5.md) | N |
| [TimescaleDB credentials](https://docs.n8n.io/integrations/builtin/credentials/timescaledb.md) | N |
| [Todoist credentials](https://docs.n8n.io/integrations/builtin/credentials/todoist.md) | N |
| [Toggl credentials](https://docs.n8n.io/integrations/builtin/credentials/toggl.md) | N |
| [TOTP credentials](https://docs.n8n.io/integrations/builtin/credentials/totp.md) | P |
| [Travis CI credentials](https://docs.n8n.io/integrations/builtin/credentials/travisci.md) | N |
| [Trellix ePO credentials](https://docs.n8n.io/integrations/builtin/credentials/trellixepo.md) | N |
| [Trello credentials](https://docs.n8n.io/integrations/builtin/credentials/trello.md) | N |
| [Twake credentials](https://docs.n8n.io/integrations/builtin/credentials/twake.md) | N |
| [Twilio credentials](https://docs.n8n.io/integrations/builtin/credentials/twilio.md) | N |
| [Twist credentials](https://docs.n8n.io/integrations/builtin/credentials/twist.md) | N |
| [Typeform credentials](https://docs.n8n.io/integrations/builtin/credentials/typeform.md) | N |
| [Unleashed Software credentials](https://docs.n8n.io/integrations/builtin/credentials/unleashedsoftware.md) | N |
| [UpLead credentials](https://docs.n8n.io/integrations/builtin/credentials/uplead.md) | N |
| [uProc credentials](https://docs.n8n.io/integrations/builtin/credentials/uproc.md) | N |
| [UptimeRobot credentials](https://docs.n8n.io/integrations/builtin/credentials/uptimerobot.md) | N |
| [urlscan.io credentials](https://docs.n8n.io/integrations/builtin/credentials/urlscanio.md) | N |
| [Venafi TLS Protect Cloud credentials](https://docs.n8n.io/integrations/builtin/credentials/venafitlsprotectcloud.md) | N |
| [Venafi TLS Protect Datacenter credentials](https://docs.n8n.io/integrations/builtin/credentials/venafitlsprotectdatacenter.md) | N |
| [Vercel AI Gateway credentials](https://docs.n8n.io/integrations/builtin/credentials/vercel.md) | N |
| [Vero credentials](https://docs.n8n.io/integrations/builtin/credentials/vero.md) | N |
| [VirusTotal credentials](https://docs.n8n.io/integrations/builtin/credentials/virustotal.md) | N |
| [Vonage credentials](https://docs.n8n.io/integrations/builtin/credentials/vonage.md) | N |
| [Weaviate credentials](https://docs.n8n.io/integrations/builtin/credentials/weaviate.md) | N |
| [Webex by Cisco credentials](https://docs.n8n.io/integrations/builtin/credentials/ciscowebex.md) | N |
| [Webflow credentials](https://docs.n8n.io/integrations/builtin/credentials/webflow.md) | N |
| [Webhook credentials](https://docs.n8n.io/integrations/builtin/credentials/webhook.md) | N |
| [Wekan credentials](https://docs.n8n.io/integrations/builtin/credentials/wekan.md) | N |
| [WhatsApp Business Cloud credentials](https://docs.n8n.io/integrations/builtin/credentials/whatsapp.md) | N |
| [Wise credentials](https://docs.n8n.io/integrations/builtin/credentials/wise.md) | N |
| [Wolfram\|Alpha credentials](https://docs.n8n.io/integrations/builtin/credentials/wolframalpha.md) | N |
| [WooCommerce credentials](https://docs.n8n.io/integrations/builtin/credentials/woocommerce.md) | N |
| [WordPress credentials](https://docs.n8n.io/integrations/builtin/credentials/wordpress.md) | N |
| [Workable credentials](https://docs.n8n.io/integrations/builtin/credentials/workable.md) | N |
| [Wufoo credentials](https://docs.n8n.io/integrations/builtin/credentials/wufoo.md) | N |
| [X (formerly Twitter) credentials](https://docs.n8n.io/integrations/builtin/credentials/twitter.md) | N |
| [xAI credentials](https://docs.n8n.io/integrations/builtin/credentials/xai.md) | P |
| [Xata credentials](https://docs.n8n.io/integrations/builtin/credentials/xata.md) | N |
| [Xero credentials](https://docs.n8n.io/integrations/builtin/credentials/xero.md) | N |
| [Yourls credentials](https://docs.n8n.io/integrations/builtin/credentials/yourls.md) | N |
| [Zabbix credentials](https://docs.n8n.io/integrations/builtin/credentials/zabbix.md) | N |
| [Zammad credentials](https://docs.n8n.io/integrations/builtin/credentials/zammad.md) | N |
| [Zendesk credentials](https://docs.n8n.io/integrations/builtin/credentials/zendesk.md) | N |
| [Zep credentials](https://docs.n8n.io/integrations/builtin/credentials/zep.md) | N |
| [Zoho credentials](https://docs.n8n.io/integrations/builtin/credentials/zoho.md) | N |
| [Zoom credentials](https://docs.n8n.io/integrations/builtin/credentials/zoom.md) | N |
| [Zscaler ZIA credentials](https://docs.n8n.io/integrations/builtin/credentials/zscalerzia.md) | N |
| [Zulip credentials](https://docs.n8n.io/integrations/builtin/credentials/zulip.md) | N |

## Checking the counts

Verified 2026-10-26: core 69, app actions 275, app triggers 91, AI 95 (24 roots, 71 sub-nodes), credential guides 322;
no duplicate URL, every URL of the index present once. Re-check after saving the index to an ignored scratch file:

```python
import re, pathlib
index = pathlib.Path(".tmp/n8n-llms.txt").read_text()
doc = pathlib.Path("docs/research/n8n-nodes.md").read_text()
pat = r"^[-|] \[[^\]\n]+?\]\((https://docs\.n8n\.io/integrations/builtin/[^)]+)\)"
src, rows = set(re.findall(pat, index, re.M)), re.findall(r"^\| \[[^\]\n]+?\]\((https://docs\.n8n\.io/integrations/builtin/[^)]+)\)", doc, re.M)
def ok(u, c):
    t = u.split(f"/builtin/{c}/", 1)
    return len(t) == 2 and re.fullmatch(r"(?:root-nodes|sub-nodes)/[^/]+\.md" if c == "cluster-nodes" else r"[^/]+\.md", t[1])
for c in ("core-nodes", "app-nodes", "trigger-nodes", "cluster-nodes", "credentials"):
    want = {u for u in src if ok(u, c)}; have = [u for u in rows if ok(u, c)]
    assert len(have) == len(set(have)) and set(have) == want, (c, want - set(have), set(have) - want)
    print(c, len(have))
```
