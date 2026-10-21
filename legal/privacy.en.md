# {{siteName}} privacy notice

Effective from: {{effectiveDate}}. Information under Articles 13 and 14 of Regulation (EU) 2016/679 (the "**GDPR**"). The Polish version is binding.

## 1. Controller {#controller}

The controller of your personal data is **{{operatorName}}**, {{postalAddress}} (the "**Operator**"), a private individual who runs {{siteName}} ({{siteUrl}}) privately and non-commercially. Contact for everything about your data: **{{contactEmail}}**. The Operator has not appointed a data protection officer (there is no obligation to).

## 2. Where your data is {#where}

- The Service and all Account data are stored on the **Operator's private computer in Poland**, not in a data centre: the Operator applies the safeguards in section 10, but cannot offer the physical protection and redundancy of professional hosting.
- Account files (CV data, documents, conversations, drafts, the repository connection) are stored **encrypted** (AES-256-GCM, a separate key per Account). AI provider API keys are encrypted and never shown in full. The encryption key is on the same computer, so the Operator, as the server's administrator, is technically able to access the data. The Operator does not look at it, and uses that ability only when resolving a problem you reported, when the law requires it, or for the security of the Service.
- **{{mailRelay}}** is used only as a relay for outgoing Service e-mail; it does not host Accounts or other Service data. It receives the recipient address, the Service-generated transactional message (for example, an Account name or one-time confirmation/reset link, depending on the message), and delivery metadata needed to send it. CVs, documents, AI conversations and other Account content are not sent there.
- Backups, where they are made, are kept on the Operator's own storage in Poland and are overwritten after **{{backupRetentionDays}} days**. Data you delete (also together with your Account) is gone from the backups at the latest after that time; until then backups are used only to restore the Service after a failure.

## 3. What data, why, on what basis, and for how long {#data}

| Data | Purpose | Basis (GDPR) | Retention |
|---|---|---|---|
| Username, display name, e-mail address, password hash (scrypt), role, status, creation and last-login dates, storage limit, date and version of accepting the Terms | creating and running your Account | Art. 6(1)(b) (contract) | until the Account is deleted; an unconfirmed registration 24 hours |
| Login sessions (token hash, created, expiry and last-used times), a known-device marker | keeping you signed in, protecting the Account against takeover | Art. 6(1)(b) and (f) | session up to 30 days or until you log out; device marker up to 180 days |
| Content: CV profile and versions (including a photo), job offers and applications, documents (with versions and trash), AI assistant conversations, course progress, website/repository connection (repository, branch, token, audit history), tool drafts | providing the services you ask for | Art. 6(1)(b) | until you delete it or delete the Account; document trash 30 days |
| AI provider settings (address, model, encrypted API key), MCP keys (hashes only) | the AI assistant, and your programs' access to the Account | Art. 6(1)(b) | until changed, revoked or the Account is deleted |
| Usage counters (such as model tokens used) | fair sharing of resources, limits | Art. 6(1)(b) and (f) | until the Account is deleted |
| Data from GitHub when you sign in with GitHub: GitHub id and login, the name on your profile, your verified e-mail address; the installations and repositories you can access | signing in, linking the Account, the website studio | Art. 6(1)(b) | until you unlink GitHub or delete the Account |
| Security events: event type, account name, IP address (for IPv6 the /64 prefix), time | security of the Service, detecting abuse and attacks | Art. 6(1)(f) (legitimate interest: network and information security, recital 49) | 30 days |
| Rate-limit and block counters (IP address, number of requests) | protection against overload and abuse | Art. 6(1)(f) | in server memory, minutes to hours |
| Technical logs of the server, the mail server and the reverse proxy (IP address, time, page address, browser, status; for mail the recipient address and delivery status) | operating and securing the Service, fixing faults | Art. 6(1)(f) | up to {{logRetentionDays}} days |
| E-mails sent to you (recipient address and generated transactional content, such as an Account name or one-time link) | confirming the address, password resets, security and change notices | Art. 6(1)(b) and (f) | messages are relayed only to deliver them; delivery logs as above; an address that bounces is blocked for 30 days (stored only as a hash) |
| Correspondence with the Operator, complaints, notices of illegal content | handling them, DSA obligations, defending against claims | Art. 6(1)(c) (DSA) and (f) | until the matter is closed, then until claims are time-barred |
| Addresses of pages you ask to fetch (job offers, company sites) or audit | carrying out the requested feature | Art. 6(1)(b) | with the offer or the audit history |

The Operator does not use your data for marketing, profiling or training AI models, and does not sell it to anyone. Tools that run in the browser send data to the server only when the tool must compute there (for example OCR); the working files are deleted when the job ends.

## 4. Recipients {#recipients}

- **{{mailRelay}}**: the provider of a virtual server used only to relay outgoing Service e-mail. To deliver a message it receives the recipient address, the generated transactional message (which may contain an Account name or a one-time link), and technical delivery metadata. It does not receive other Account data such as CVs, documents or AI conversations. It acts as a processor for this limited purpose (Article 28 GDPR).
- **The AI provider you chose**: when you use the AI assistant, the Service sends, at your request, the conversation and data from open tools to the address configured in your Account. The provider processes it under **your contract with them** and their own privacy policy, not on the Operator's behalf. Do not send it other people's data you have no right to share.
- **GitHub, Inc.** (USA): when you sign in with GitHub and work with a repository; GitHub acts as an independent controller for your GitHub account ([GitHub privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
- **Google LLC** (USA): when you audit a site with PageSpeed Insights, the address of the audited site is sent there (from the Operator's server, without your IP address).
- **Sites you point the Service at** (job offers, company sites, audited sites): they only see the IP address of the Operator's server.
- Public authorities: only where the law requires it.

## 5. Transfers outside the European Economic Area {#transfers}

GitHub and Google are based in the USA. Transfers rely on the European Commission's Decision (EU) 2023/1795 on the EU–US Data Privacy Framework where the recipient is certified under it, and otherwise on standard contractual clauses. If the AI provider you chose is outside the EEA, sending data to it is necessary to provide the service you ask for (Article 49(1)(b) GDPR), and your contract with that provider governs what happens next.

## 6. Cookies and browser storage {#cookies}

The Service stores on your device only information that is **strictly necessary to provide the service you ask for** (Article 399(3) of the Polish Electronic Communications Law), so it does not ask for consent. There is no analytics, no advertising and no third-party script.

| Name | Kind | Purpose | Lifetime |
|---|---|---|---|
| `knife_session` | cookie | keeping you signed in | up to 30 days |
| `knife_device` | cookie | recognising a device you signed in on before (protection against account takeover) | up to 180 days |
| `knife_gh_state` | cookie | securing "Sign in with GitHub" | 10 minutes |
| `sk-theme`, tool settings | local storage | light or dark theme, your tool settings | until you clear it in the browser |
| a copy of the AI assistant conversation, the message queue, trust mode, SQL settings | local storage | running the assistant and the tools without reloading | removed when you log out |

You can delete these in your browser settings; without the session cookie you cannot sign in.

## 7. Your rights {#rights}

You have the right of access to your data and to a copy, to rectification, erasure, restriction of processing, data portability, and to **object** to processing based on legitimate interest (Articles 15–21 GDPR). You can delete your Account and all its data yourself in the Account settings; send any other request to {{contactEmail}}. The Operator answers without undue delay and within one month at the latest.

## 8. Complaint to the supervisory authority {#complaint}

You have the right to lodge a complaint with the **President of the Personal Data Protection Office** (Prezes Urzędu Ochrony Danych Osobowych), ul. Stanisława Moniuszki 1A, 00-014 Warszawa, Poland ([uodo.gov.pl](https://uodo.gov.pl)).

## 9. Do you have to provide data {#required}

A username, an e-mail address and a password (or signing in with GitHub) are required to create an Account. Everything else you provide voluntarily when you use the features you choose; an AI provider API key is only needed for the AI assistant.

## 10. Security and breaches {#security}

Connections are encrypted (HTTPS), Account files and API keys are encrypted, passwords are stored as hashes, the server is protected by a firewall and limits, and the tools that process files run in an isolated environment (sandbox). If there is a personal data breach, the Operator notifies the Personal Data Protection Office within 72 hours where required and, if the risk to you is high, tells you without undue delay.

## 11. Automated decisions {#automated}

The Operator makes no decisions based solely on automated processing, including profiling, that produce legal effects for you or similarly significantly affect you. Automatic limits and blocks against abuse are temporary and do not assess you as a person.

## 12. Age {#age}

The Service is intended for people aged {{minimumAge}} or older.

## 13. Special-category data and other people's data {#special}

A CV may contain special categories of data (such as health or disability) and other people's data (such as references). Store them only when needed and when you have the right to.

## 14. Changes {#changes}

The Operator announces material changes to this notice by e-mail and in the Service, in the same way as changes to the Terms.
