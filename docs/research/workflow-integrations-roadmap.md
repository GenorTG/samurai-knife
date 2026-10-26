# Workflow integrations roadmap

What comes after the first 12 service nodes, in which order, and when a node counts as implemented. The full list of
documented n8n nodes, their priorities and auth prerequisites: [n8n-nodes.md](n8n-nodes.md). Engine contract:
[WORKFLOWS.md](../WORKFLOWS.md). As of 2026-10-26; every external provider is provider-live unverified until a row below
says otherwise.

## Acceptance gates

A node is **implemented** (I in the inventory) only when all of these hold; until then it is P (partial) or N:

1. **Real operation semantics.** Named operations with the provider's documented request and response shapes, not a
   generic HTTP wrapper. The spec cites the official API reference of every operation (`docs`).
2. **Fixed host, safe paths.** The documented API host is built in; no base-URL override, path segments encoded, IDs
   never resolved as URLs, redirects not followed, every request through `sendAuthorized` (outbound policy, OAuth
   refresh before expiry or once after a 401).
3. **Validation before side effects** and provider error envelopes turned into readable item errors (Slack `ok:false`,
   Graph/Google `error`, Notion `object:"error"`…).
4. **Bounded lists**: a total result cap and a page budget, never an unbounded loop.
5. **Credential binding**: the node lists the credential types it accepts; a setup recipe in the Credentials tab names the
   scopes each operation needs, the console to register in and the callback URL.
6. **Tests**: `tests/workflow_integrations.test.mjs` drives `runWorkflow` with provider-shaped fixtures for every
   operation (method, path, auth header, body, output), failures, malicious IDs, OAuth refresh and several items;
   `tests/functional/workflows_e2e.py` finds the node in the picker and shows its fields in a real browser.
7. **Interface texts** in the catalogue (`node scripts/i18n-extract.mjs --write`, Polish in `src/lib/i18n/pl.json`).
8. **Provider-live status recorded separately**: who ran which operation against the real service, when, with which
   account type. Without that the inventory keeps the note "provider-live unverified" even for an I row.

## Batches

| Batch | Scope | Depends on | Status |
| --- | --- | --- | --- |
| 0 | Engine, core nodes, AI nodes, credential types, OAuth2 with presets | — | done (0.7–0.10) |
| 1 | GitHub, GitLab, Slack, Discord, Notion, Airtable, Google Sheets/Drive/Calendar, Outlook, Teams, HubSpot (26 operations) + setup recipes | batch 0 | done (0.11), provider-live unverified |
| 2 | Wider operations on batch 1 services (GitHub PRs/releases, Slack files/reactions, Sheets update/clear, Drive upload/download with binary items, Calendar update/delete, Outlook folders), Gmail, Google Docs, Telegram, Trello, Asana, Jira, Stripe, Mailchimp | batch 1; binary items in specs | planned |
| 3 | Triggers for batch 1–2 services: webhook registration/renewal/removal, raw-body signature checks, dedup/replay, polling cursors | a trigger lifecycle in the server (subscriptions table, renewal job) | planned |
| 4 | Protocol nodes: Postgres, MySQL, MongoDB, Redis, SMTP send (the credential exists), IMAP trigger, SFTP | per-protocol drivers in the worker with the outbound policy | planned |
| 5 | Provider families with special auth: AWS (SigV4, STS roles), Google service accounts, Microsoft app-only/certificate, Salesforce JWT bearer, Meta pages/WhatsApp, LinkedIn | auth adapters beyond OAuth2 code + PKCE | planned |
| 6 | AI cluster parity: native Anthropic/Gemini protocols, embeddings, vector stores, retrievers, document loaders | a typed sub-node connection model | planned |
| — | Everything else in the inventory (A before B, P reviewed case by case) | by demand | backlog |

## Not planned

Host shell (Execute Command), host filesystem (Read/Write Files from Disk, Local File Trigger), n8n's own administration
API and lifecycle triggers, n8n training sample services. Reasons in the inventory's X rows.
