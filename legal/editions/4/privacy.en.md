# {{siteName}} privacy notice

Effective from: {{effectiveDate}}. Information under Articles 13 and 14 of Regulation (EU) 2016/679 (the "**GDPR**"). The Polish version is binding. What changed since the previous version: section 15.

## 1. Controller {#controller}

The controller of your personal data is **{{operatorName}}**, {{postalAddress}} (the "**Operator**"), a private individual who runs {{siteName}} ({{siteUrl}}) privately and non-commercially. Contact for everything about your data: **{{contactEmail}}**. The Operator has not appointed a data protection officer (there is no obligation to).

## 2. Where your data is {#where}

- The Service and all Account data are stored on the **Operator's private computer in Poland**, not in a data centre: the Operator applies the safeguards in section 10, but cannot offer the physical protection and redundancy of professional hosting.
- Account files (CV data, documents, files saved from the Craft apps, conversations, drafts, workflows with their run history and credentials, the repository connection) are stored **encrypted** (AES-256-GCM, a separate key per Account). AI provider API keys and workflow credentials are encrypted and never shown in full again after saving. The encryption key is on the same computer, so the Operator, as the server's administrator, is technically able to access the data. The Operator does not look at it, and uses that ability only when resolving a problem you reported, when the law requires it, or for the security of the Service.
- **Workflows** run on the Operator's server, each run in a separate, isolated process. A workflow sends data only where its nodes say: to the addresses and services you entered in it (for example an HTTP request or an integration), using the credentials you saved, and to the AI provider of an AI node. Those recipients act under your relationship with them (section 4).
- **Craft apps** (where this instance offers them): third-party open-source programs by the ArtCraft team (PhotoCraft, VectorCraft, FilmCraft and others) that the Operator serves unmodified from its own server, on a separate address. They run entirely in your browser: your work stays in the browser's storage for that address (section 6) until you save it to your Account as a Craft file. Nothing is sent to the ArtCraft team. To keep the apps up to date, the server asks GitHub for new releases of the apps; those requests carry no data about you.
- **{{mailRelay}}** is used only as a relay for outgoing Service e-mail; it does not host Accounts or other Service data. It receives the recipient address, the Service-generated transactional message (for example, an Account name or one-time confirmation/reset link, depending on the message), and delivery metadata needed to send it. CVs, documents, AI conversations and other Account content are not sent there. The connection to the relay is always encrypted (TLS), and onward to the recipient's mail server whenever that server supports it. The relay does not keep messages once delivered; its log holds the recipient address, time and delivery status (no subject or body) and is deleted after {{logRetentionDays}} days.
- Backups, where they are made, are kept on the Operator's own storage in Poland and are overwritten after **{{backupRetentionDays}} days**. Data you delete (also together with your Account) is gone from the backups at the latest after that time; until then backups are used only to restore the Service after a failure.

## 3. What data, why, on what basis, and for how long {#data}

| Data | Purpose | Basis (GDPR) | Retention |
|---|---|---|---|
| Username, display name, e-mail address, password hash (scrypt), role, status, creation and last-login dates, storage limit, date and version of accepting the Terms, chosen interface language | creating and running your Account | Art. 6(1)(b) (contract) | until the Account is deleted; an unconfirmed registration 24 hours |
| Login sessions (token hash, created, expiry and last-used times), a known-device marker | keeping you signed in, protecting the Account against takeover | Art. 6(1)(b) and (f) | session up to 30 days or until you log out; device marker up to 180 days |
| Content: CV profile and versions (including a photo), job offers and applications, documents (with versions and trash), files you save from the Craft apps, AI assistant conversations, course progress, website/repository connection (repository, branch, the GitHub token and, if you connect Vercel, the Vercel token and the project's preview bypass secret, audit history), tool drafts | providing the services you ask for | Art. 6(1)(b) | until you delete it or delete the Account; document trash 30 days |
| Workflows: their nodes, settings, triggers (schedules, webhook addresses) and notes; data tables and the data a workflow keeps between runs (such as an AI agent's memory or items already seen); resume links of waiting runs | running the automations you build | Art. 6(1)(b) | until you delete the workflow or the Account |
| Workflow run history: when and how a run started, each node's input and output data (shortened for large outputs), errors, duration | showing you what your workflows did, finding mistakes | Art. 6(1)(b) | the last 100 runs of each workflow, at most 14 days; you can delete runs earlier |
| Workflow credentials: name, type and secrets (API keys, passwords, tokens, the client id and secret of OAuth apps you registered, the tokens those apps issue) | letting your workflows reach the services you chose | Art. 6(1)(b) | until you delete the credential or the Account; given to a run only for the nodes that use it |
| Requests to your workflows' webhook addresses: headers (including the caller's IP address and browser as passed on by the reverse proxy; cookies are removed), query parameters, body and files | starting the workflow with the data the caller sent | towards you Art. 6(1)(b); towards the caller Art. 6(1)(f) (providing the service the User set up) | as run history |
| AI provider settings (one or more named profiles: address, model, encrypted API key), MCP keys (hashes only) | the AI assistant, AI nodes in workflows, and your programs' access to the Account | Art. 6(1)(b) | until changed, revoked or the Account is deleted |
| Usage counters (such as model tokens used by the assistant and by AI nodes) | fair sharing of resources, limits | Art. 6(1)(b) and (f) | until the Account is deleted |
| Data from GitHub when you sign in with GitHub: GitHub id and login, the name on your profile, your verified e-mail address; the installations and repositories you can access | signing in, linking the Account, the website studio | Art. 6(1)(b) | until you unlink GitHub or delete the Account |
| Security events: event type, account name, IP address (for IPv6 the /64 prefix), time | security of the Service, detecting abuse and attacks | Art. 6(1)(f) (legitimate interest: network and information security, recital 49) | 30 days |
| Rate-limit and block counters (IP address, number of requests) | protection against overload and abuse | Art. 6(1)(f) | in server memory, minutes to hours |
| Technical logs: the server's own log files (server output, operations on add-on services, updates; secrets are removed before writing), and the logs of the mail server and the reverse proxy (IP address, time, page address, browser, status; for mail the recipient address and delivery status) | operating and securing the Service, fixing faults | Art. 6(1)(f) | up to {{logRetentionDays}} days |
| E-mails sent to you (recipient address and generated transactional content, such as an Account name or one-time link) | confirming the address, password resets, security and change notices | Art. 6(1)(b) and (f) | messages are relayed only to deliver them; delivery logs as above; an address that bounces is blocked for 30 days (stored only as a hash) |
| Correspondence with the Operator, complaints, notices of illegal content | handling them, DSA obligations, defending against claims | Art. 6(1)(c) (DSA) and (f) | until the matter is closed, then until claims are time-barred |
| Addresses of pages you ask to fetch (job offers, company sites) or audit | carrying out the requested feature | Art. 6(1)(b) | with the offer or the audit history |

The Operator does not use your data for marketing, profiling or training AI models, and does not sell it to anyone. Tools that run in the browser send data to the server only when the tool must compute there (for example OCR); the working files are deleted when the job ends.

## 4. Recipients {#recipients}

- **{{mailRelay}}**: the provider of a virtual server used only to relay outgoing Service e-mail. To deliver a message it receives the recipient address, the generated transactional message (which may contain an Account name or a one-time link), and technical delivery metadata. It does not receive other Account data such as CVs, documents or AI conversations. It acts as a processor for this limited purpose (Article 28 GDPR).
- **The AI provider you chose**: when you use the AI assistant, the Service sends, at your request, the conversation and data from open tools to the address configured in your Account; when a workflow runs an AI node, the data that node is given goes to the provider of the profile or credential the node names. The provider processes it under **your contract with them** and their own privacy policy, not on the Operator's behalf. Do not send it other people's data you have no right to share.
- **Addresses and services your workflows contact**: an HTTP request or integration node sends what the workflow gives it to the address in the node, with the credentials you saved; when you connect an OAuth app, the provider of that app (for example Google, Microsoft or GitHub) takes part in the sign-in. These recipients act under your relationship with them, not on the Operator's behalf. Whoever calls your webhook address receives the answer your workflow gives.
- **Vercel Inc.** (USA): only if you connect Vercel in the website studio: with your token the server reads your Vercel project and its deployments and build logs, and starts preview builds of the work branch; Vercel acts as an independent controller for your Vercel account ([Vercel privacy policy](https://vercel.com/legal/privacy-policy)).
- **GitHub, Inc.** (USA): when you sign in with GitHub and work with a repository; GitHub acts as an independent controller for your GitHub account ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)). The Craft app update checks (section 2) also go to GitHub, without data about you.
- **Google LLC** (USA): when you audit a site with PageSpeed Insights, the address of the audited site is sent there (from the Operator's server, without your IP address).
- **Sites you point the Service at** (job offers, company sites, audited sites, addresses your workflows call): they see the IP address of the Operator's server, not yours.
- Public authorities: only where the law requires it.

## 5. Transfers outside the European Economic Area {#transfers}

GitHub, Google and Vercel are based in the USA. Transfers rely on the European Commission's Decision (EU) 2023/1795 on the EU–US Data Privacy Framework where the recipient is certified under it, and otherwise on standard contractual clauses. If the AI provider you chose, or a service your workflow contacts, is outside the EEA, sending data to it is necessary to provide the service you ask for (Article 49(1)(b) GDPR), and your contract with that provider governs what happens next.

## 6. Cookies and browser storage {#cookies}

The Service stores on your device only information that is **strictly necessary to provide the service you ask for** (Article 399(3) of the Polish Electronic Communications Law), so it does not ask for consent. There is no analytics, no advertising and no third-party script.

| Name | Kind | Purpose | Lifetime |
|---|---|---|---|
| `knife_session` | cookie | keeping you signed in | up to 30 days |
| `knife_device` | cookie | recognising a device you signed in on before (protection against account takeover) | up to 180 days |
| `knife_gh_state` | cookie | securing "Sign in with GitHub" | 10 minutes |
| `knife_vercel_state` | cookie | securing "Connect with Vercel" in the website studio | 10 minutes |
| `knife_office` | cookie on the office editor's address (where offered) | letting your browser load the editor for your document | up to 6 hours |
| `knife_craft` | cookie on the Craft apps' address (where offered) | letting your browser load the Craft apps | up to 12 hours |
| `knife_lang` | cookie | the interface language you chose with the switch (Polish or English) | 1 year |
| the Craft apps' own storage (preferences, photo libraries, projects and media, recovery copies of open documents) | local storage, IndexedDB, OPFS on the Craft apps' address | the apps working in your browser | until you clear it in the browser; never sent to the server |
| `knife:account` | local storage on the Craft apps' address | an opaque marker of the Account that used the apps last in this browser, so another Account's local data is cleared before the apps open | until you clear it in the browser |
| `sk-theme`, tool settings | local storage | light or dark theme, your tool settings | until you clear it in the browser |
| a copy of the AI assistant conversation, the message queue, trust mode, SQL settings | local storage | running the assistant and the tools without reloading | removed when you log out |

You can delete these in your browser settings; without the session cookie you cannot sign in.

## 7. Your rights {#rights}

You have the right of access to your data and to a copy, to rectification, erasure, restriction of processing, data portability, and to **object** to processing based on legitimate interest (Articles 15–21 GDPR). You can delete your Account and all its data yourself in the Account settings, and parts of it where they are shown: documents and Craft files ("My files"), workflows, their runs and credentials (in the workflow editor). Send any other request to {{contactEmail}}. The Operator answers without undue delay and within one month at the latest. If you sent data to a webhook address of another User's workflow, you can also ask that User; the Operator helps where the User does not answer.

## 8. Complaint to the supervisory authority {#complaint}

You have the right to lodge a complaint with the **President of the Personal Data Protection Office** (Prezes Urzędu Ochrony Danych Osobowych), ul. Stanisława Moniuszki 1A, 00-014 Warszawa, Poland ([uodo.gov.pl](https://uodo.gov.pl)).

## 9. Do you have to provide data {#required}

A username, an e-mail address and a password (or signing in with GitHub) are required to create an Account. Everything else you provide voluntarily when you use the features you choose; an AI provider API key is only needed for the AI assistant and for AI nodes.

## 10. Security and breaches {#security}

Connections are encrypted (HTTPS), Account files, API keys and workflow credentials are encrypted, passwords are stored as hashes, the server is protected by a firewall and limits, and the tools that process files run in an isolated environment (sandbox). Workflows run in a separate process without access to the server's files or to other Accounts; code you write in a workflow runs in a further sandbox with time and memory limits, and on the public Service workflows cannot reach addresses in the Operator's private network. The Craft apps run on their own address, separate from the Service, so they cannot read your Account. If there is a personal data breach, the Operator notifies the Personal Data Protection Office within 72 hours where required and, if the risk to you is high, tells you without undue delay.

## 11. Automated decisions {#automated}

The Operator makes no decisions based solely on automated processing, including profiling, that produce legal effects for you or similarly significantly affect you. Automatic limits and blocks against abuse are temporary and do not assess you as a person. Workflows do what their User built; the Operator does not use them to decide anything about you.

## 12. Age {#age}

The Service is intended for people aged {{minimumAge}} or older.

## 13. Special-category data and other people's data {#special}

A CV may contain special categories of data (such as health or disability) and other people's data (such as references), and a workflow may handle other people's data (such as messages or form entries it receives or fetches). Store and process them only when needed and when you have the right to.

## 14. Changes {#changes}

The Operator announces material changes to this notice by e-mail and in the Service, in the same way as changes to the Terms.

## 15. Versions of this notice and of {{siteName}} {#versions}

Every change of the text or of the instance's details is a new version. The bottom of this page shows its edition, its fingerprint (a short code computed from the full text) and the {{siteName}} version the server runs; earlier versions are listed there and stay readable. Your Account settings show the version you accepted at sign-up.

What each version of {{siteName}} added that matters for your data:

| {{siteName}} version | Added | What it means for your data |
|---|---|---|
| 0.1 | Accounts, browser tools, CV studio, office documents, database course, website studio, AI assistant, MCP keys, sign-in with GitHub | as described in edition 1 of this notice |
| 0.2 | The server's own log files; the Craft apps | technical logs kept up to {{logRetentionDays}} days; the apps keep your work in your browser |
| 0.4 | Automatic updates of the Craft apps from GitHub | requests to GitHub without data about you |
| 0.5 | Craft files: saving work from the Craft apps in your Account | stored encrypted in the Account, counted in the storage limit |
| 0.6.1 | Several named AI provider profiles | each profile's API key stored encrypted |
| 0.7.0 | Workflows: automations with schedules, webhook addresses, code and credentials | workflows, run history (100 runs, 14 days), encrypted credentials, data sent to your webhooks |
| 0.7.1 | AI nodes in workflows; the assistant and MCP can build and run workflows | workflow data goes to the AI provider you chose; token use is counted |
| 0.8.0 | Versions of the Terms and this notice: earlier versions stay readable | the version you accepted is shown in your Account; no new personal data |
| 0.10.0 | The interface in Polish and English | the language you choose is kept in the `knife_lang` cookie and on your Account; e-mails come in that language |
| 0.13.0 | Optional Vercel connection of the website studio | your Vercel token and the project's bypass secret are stored encrypted; requests go to Vercel only after you connect it |

Changes:

- **Edition 4** (28 October 2026, {{siteName}} 0.13.0): adds the optional Vercel connection of the website studio (Vercel token and bypass secret, Vercel as a recipient) and the `knife_vercel_state` cookie.
- **Edition 3** (26 October 2026, {{siteName}} 0.10.0): adds the interface language to the Account data and the `knife_lang` cookie.
- **Edition 2** (22 October 2026, {{siteName}} 0.8.0): describes the Craft apps and Craft files, workflows (run history, credentials, webhooks, AI nodes), several AI provider profiles, the server's log files and the `knife_office`, `knife_craft` and Craft app storage entries; adds this section.
- **Edition 1** (21 October 2026, {{siteName}} 0.1): first version.
