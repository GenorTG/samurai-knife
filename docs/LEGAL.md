# Legal pages and operator duties

Smart Knife ships default Terms of Service and a privacy notice for a **free, non-commercial instance run by a private
individual in Poland** (Polish binding, English informative): `legal/terms.{pl,en}.md`, `legal/privacy.{pl,en}.md`.
Research state: October 2026, read from the official texts (ISAP/ELI for Polish acts, EUR-Lex for EU acts). **This is
not legal advice.** If you run an instance commercially (any money: donations for access, ads, a paid tier) most of the
conclusions below change: see "If money is involved".

## How it works

- `/terms` and `/privacy` (public in both modes): Polish for a Polish browser, else English, `?lang=pl|en`; a download
  link (`GET /api/legal?doc=&lang=`) gives the page as Markdown (UŚUDE art. 8: a form you can store and print).
- Texts: `$KNIFE_LEGAL_DIR/<doc>.<lang>.md` if present, else the defaults in `legal/`. Values: `$KNIFE_LEGAL_DIR/legal.json`
  fills `{{placeholders}}` (`legal/README.md` lists them). `KNIFE_LEGAL_DIR` defaults to `$KNIFE_DATA_DIR/legal`; the
  systemd install uses `/etc/samurai-knife/legal` (root:knife, read-only to the app). Nothing of an instance is in git.
- Version: legal.json `version`, else a fingerprint (hash) over every rendered page with the effective date left out.
  `GET /api/legal` returns it with the edition and the instance's history.
- Editions and history: `legal/versions.json` lists the editions of the defaults (number, date, app version, digest of
  the four files) and what the current edition covers; `legal/editions/<n>/` keeps earlier texts (`?edition=<n>`). The
  instance records each version the first time it is shown or accepted (legal pages, /register, every sign-up) in
  `$KNIFE_DATA_DIR/legal-history/<key>.json` (exact texts, first-shown time, app version, per-document digests; first
  write wins); the pages list them and `?version=<fingerprint>` (also on the download) reads one. The effective date
  shown is legal.json `effectiveDate` or the first-shown day, whichever is later. When the Terms text differs from the
  previous recorded version, the Terms page says that older accounts are bound from first-shown + `changeNoticeDays`
  (Terms § 15.4). Account settings show the accepted version with a link to it (or, for an acceptance from before the
  history, the edition in force that day).
- Sign-up: one checkbox ("I accept the Terms … have read the privacy notice") gates the password form and "Sign up with
  GitHub". `POST /api/account/register` needs `acceptTerms` = the current version (400 `terms_required`, 409
  `terms_changed`); "Sign up with GitHub" carries it in the sealed OAuth state, and a new GitHub user who came from
  /login without it is sent to /register (`terms_required`). The account stores `termsAcceptedAt` and `termsVersion`
  (proof of what was accepted). Existing accounts, and accounts made with the CLI, have `null` there.
- The assistant widget says it is an AI system under the message box (AI Act art. 50(1)/(5)) and links to the Terms.
- Renderer (`src/lib/legal/legal.ts`): raw HTML in a text is shown as text, links only http(s)/mailto/same-site, no
  images, `## Heading {#id}` gives a stable anchor. Missing placeholders show as `[name?]` plus a warning on the page.
- Tests: `tests/legal.test.mjs` (also the guards in "Changing the texts"), the register/GitHub checks in `tests/github_app.test.mjs`,
  `tests/functional/accounts_public_e2e.py` and `tests/functional/github_app_e2e.py`.

## Changing the texts

A feature that stores new personal data, sets a new cookie or browser storage entry, or sends data to a new recipient
needs the privacy notice (and, for a new service or rule, the Terms) changed **in the same release**. The repo is held to
it by `tests/legal.test.mjs`:

- a cookie constant (`*COOKIE = "knife_…"`, `COOKIE_NAME`) or a `StorageArea` (src/lib/storage/quota.ts) missing from
  `legal/versions.json` `covers` fails, and every covered cookie must appear in both privacy texts;
- a change of `legal/*.md` without a matching digest in `legal/versions.json` fails, printing the new digest;
- the newest edition must be named, with its app version, in each text's change history (Terms § 17 `{#history}`,
  privacy § 15 `{#versions}`).

Steps for a new edition: copy the released texts (from the last tag) to `legal/editions/<n>/`, edit `legal/*.md` in both
languages, add a row to the privacy notice's "what each version added" table and a line to both change histories, add
`{ edition: n+1, published, app, digest }` on top of `legal/versions.json` (the test prints the digest), update `covers`.
Until the edition is released, further edits only update its digest. After deploying, e-mail existing users about
material changes (Terms § 15.2, privacy § 14).

## What applies to a private, non-commercial operator in Poland

| Law | Applies? | What the defaults do |
|---|---|---|
| **GDPR** (Reg. 2016/679) | **Yes.** The household exemption does not cover offering a service to others (recital 18; CJEU C-101/01, C-212/13). | Privacy notice with every art. 13 item and art. 14 for GitHub data; bases 6(1)(b) contract, 6(1)(f) security (recital 49), 6(1)(c) DSA; retention per item; recipients; DPF transfers (Decision 2023/1795, still valid; the appeal C-703/25 P against T-553/23 *Latombe* is pending); complaint to the Prezes UODO, **ul. Stanisława Moniuszki 1A, 00-014 Warszawa** (the office moved from ul. Stawki 2). |
| **UŚUDE** (Dz.U. 2024 poz. 1513) | **Probably not**: "usługodawca" (art. 2 pkt 6) requires "działalność zarobkowa lub zawodowa"; uncertain if the service doubles as a professional showcase. | Complied with voluntarily: art. 8 regulamin content (scope, technical requirements, ban on unlawful content, conclusion/termination, complaints), available before sign-up, downloadable. Art. 5 would require "imię, nazwisko, miejsce zamieszkania i adres": see "Postal address". |
| **DSA** (Reg. 2022/2065) | **Uncertain**: an information society service is one "normally provided for remuneration" (Dir. 2015/1535 art. 1(1)(b)). If it applies, Smart Knife is a **hosting service**, not an online platform (nothing is published to the public). The Polish DSA act (Dz.U. 2026 poz. 1296, in force **6 Nov 2026**) repeals UŚUDE art. 12–15 (safe harbour now DSA art. 6) and adds fines for art. 11, 12, 14, 16–18. | Complied with voluntarily: one contact point for users and authorities, PL/EN (art. 11–12); moderation policy in the Terms (art. 14); notice-and-action by e-mail (art. 16); statement of reasons and appeal (art. 17); reporting threats to life or safety (art. 18). |
| **AI Act** (Reg. 2024/1689 as amended by 2026/1744) | **Likely**, as the provider of the assistant ("free of charge" counts; "putting into service" needs no commercial activity). Art. 50 applies from 2 Aug 2026. | "You are chatting with an AI system" under the message box and in the Terms; users reminded of art. 50(4). Art. 4 (AI literacy, rewritten in 2026) concerns staff: nothing for a one-person operator. |
| **Prawo komunikacji elektronicznej** (Dz.U. 2024 poz. 1221) art. 399 | **Yes** (anyone storing data on a device). | Only strictly necessary cookies/local storage (ust. 3 pkt 2): no consent banner; the privacy notice lists each item. Adding analytics or third-party embeds would need consent. |
| Consumer law (Ustawa o prawach konsumenta, Dir. 2019/770, KC art. 385¹), Polish-language act art. 7–8, Rome I art. 6, Brussels I bis art. 17 | **Probably not**: they need a trader (przedsiębiorca, KC art. 43¹). | Fair clauses anyway; a savings clause for mandatory consumer law; Polish version binding. |
| Civil code (KC) | **Yes.** | Terms as a wzorzec umowy given before the contract (art. 384) with a change procedure (art. 384¹: notice, right to leave); liability limited to intent and gross negligence "to the extent permitted by law" (intent cannot be excluded, art. 473 §2; cf. art. 891 §1 for gratuitous contracts); termination of a free service contract (art. 746, 750); a content licence with named fields of use (prawo autorskie art. 41, 65–67). |

## Operator duties besides the pages (not published)

1. **Record of processing activities** (GDPR art. 30): the "<250 employees" exemption does not cover regular processing.
   One table: purposes, categories of data and people, recipients, transfers, retention, security (the privacy notice
   table is a good start).
2. **Breach log** (art. 33(5)), and the 72-hour notification to UODO when a breach is likely to risk people's rights.
3. **Processing agreement with your mail relay host** (art. 28): the relay is used only for outgoing Service e-mail, not for hosting Accounts or other Service data. It nevertheless receives the recipient address, generated transactional message (which can include an Account name or one-time link), and delivery metadata. The hosting terms you accepted at sign-up are not necessarily an art. 28(3) processing agreement; verify and sign the separate contract covering instructions, confidentiality, security, sub-processors, deletion and audits. netcup offers a click-through in CCP > Master Data > Order Processing > "Create AV Contract". Keep the PDF.
4. **Make the retention numbers true**: the reverse proxy, app and mail-server logs must not outlive
   `logRetentionDays`, backups `backupRetentionDays` (deleted data leaves the backups when they are overwritten).
   - The app's own log files (`$KNIFE_LOG_DIR`: server output, sidecar ops, updater runs; docs/DEPLOY.md "Log files")
     follow `logRetentionDays` by themselves: a day file is deleted once its day is that many days old (checked at
     startup and hourly). The updater's copy of the number comes from the installer: rerun `deploy/install.sh` after
     changing it. Security events (`$KNIFE_DATA_DIR/security/`) are kept 30 days: keep `logRetentionDays` at 30 or more.
   - journald: a drop-in with `MaxRetentionSec=` one day under the limit and `MaxFileSec=1day` (journald deletes whole
     files, and the default file span is a month).
   - Docker's `json-file` driver rotates by size only, so a quiet container keeps lines for months: give containers that
     log client IPs or recipients (mail server, proxy) `logging: driver: journald` instead.
   - nginx-proxy-manager rotates inside its container (access logs weekly x4, error logs weekly x10, about 11 weeks):
     delete rotated `*.gz` older than the limit minus the 7-day rotation span from its `data/logs` with a daily timer.
5. **DSA, cautious**: a short yearly statement on the site ("0 orders, 0 notices, 0 restrictions") instead of relying on
   the micro-enterprise exemption, which may not literally fit a non-enterprise.
6. **Announce changes** of the texts to existing users by e-mail at least `changeNoticeDays` before they apply.

## Postal address

UŚUDE art. 5 (if it applies) asks for "miejsce zamieszkania i adres"; GDPR art. 13 needs only contact details (an e-mail
is enough). Choices: your home address (fully compliant, privacy cost); a correspondence address such as a P.O. box
(common, but not literally "miejsce zamieszkania"); or "provided on request" to your contact e-mail (defensible while the
service stays non-commercial; the riskiest).

## If money is involved

Donations for access, ads, a paid tier or sponsorship make the operator a "usługodawca" (UŚUDE applies fully, including
art. 5) and very likely a "przedsiębiorca": consumer law, KC art. 385¹ (unfair clauses), the right of withdrawal, the
Polish-language act and tax rules then apply, and the defaults are no longer enough. Get advice before that step.

## Third-party components served to browsers

- **Craft apps** (`craft` sidecar, suite slug `artcraft`, docs/SIDECARS.md "ArtCraft"): PhotoCraft, VectorCraft,
  FilmCraft, LightCraft, EffectCraft, DesignCraft, PdfCraft, FigCraft, WordCraft, SoundCraft, DeckCraft, CADCraft and
  GridCraft by the ArtCraft team (github.com/storytold; "Copyright (c) 2026 ArtCraft Team and the <app> contributors"),
  each MIT OR Apache-2.0 at the recipient's option. Embedding is what the projects document: every app's
  `packaging/web/README.md` has an "Embedding in a page (iframe)" section ("cross-origin embeds work") and the sandbox it
  needs. The instance redistributes the official release zips **unmodified** (plus `.gz` copies) from its own server.
  - Licences: the zips carry `LICENSE-MIT` and `LICENSE-APACHE` (some also `OFL-*.txt` or `ATTRIBUTION.md`) and keep
    them; most do **not** carry the repository's `NOTICE` (SoundCraft's does), which lists the third-party material bundled into the build
    (Inter/JetBrains Mono OFL-1.1, Lucide ISC, SCOWL, libfacedetection BSD-3-Clause, …). Each app tab's "licences &
    notices" view (`GET /api/craft/notices`, src/lib/craft/notices.ts) shows the copyright line, both licence texts from
    the release, and the repository's `NOTICE` plus every licence file it names, fetched from the repository at the
    release's tag (`v<version>`) and cached per version. That satisfies MIT (copyright + permission notice) and, if
    Apache-2.0 is elected, §4(a)/(d) (licence copy, NOTICE text); OFL §2 (licence with the font) through the same view.
  - Brand: the ArtCraft name, wordmark and logos are trademarks of the ArtCraft Team, NOT open source
    (`docs/brand/LICENSE-brand.txt` in each repo): they may appear only inside the apps' own official builds (which the
    instance serves unmodified), never "in the name, logo, icon, domain, … advertising or marketing of anything other
    than" the app, and nothing may suggest that the ArtCraft Team endorses another product. So the suite and the sidecar
    are called "Craft apps" (the slug `artcraft` is a URL path, kept because slugs are permanent), the craft host name
    must not contain "artcraft" (e.g. `smart-knife-craft.`), Smart Knife shows none of their logos, and every tab says
    in plain text "<App> <version> by the ArtCraft team and contributors · MIT OR Apache-2.0 · source · licences &
    notices · Not affiliated with or endorsed by the ArtCraft team". App names (PhotoCraft, …) are used only to say
    which app a tab runs. Nothing of theirs is in this repository. nginx (the container) is BSD-2-Clause.
  - Updates: the server asks `api.github.com` once a day for each app's releases and downloads new release zips from
    `github.com` (no user data is sent; requests carry only a fixed User-Agent). The licences & notices view always
    shows the texts of the version actually served.
- Privacy notice (edition 2, Smart Knife 0.8.0): § 2 says the apps are third-party programs served unmodified on their
  own address and that update checks go to GitHub without user data; § 3 lists Craft files (`craft-files/<account>/`,
  sealed, quota, deleted with the account or in "My files"); § 6 lists `knife_craft` (up to 12 hours, only with
  `KNIFE_CRAFT_PUBLIC_URL`), the apps' own storage on the craft host (local storage, IndexedDB, OPFS; never sent to the
  server) and `knife:account` (opaque account tag, so another account's data is cleared on a shared browser), all
  strictly necessary for a tool the user opens (art. 399 ust. 3 PKE), and the office editor's `knife_office` (6 hours).
  The Terms (§ 4.5, § 12.1) say the Operator is not their author, their licences apply, and the ArtCraft team is not a
  party and does not endorse the Service.
- Workflows (edition 2): § 3 rows for workflows, run history (100 runs / 14 days, `RUNS_KEPT`/`RUN_DAYS_KEPT` in
  src/lib/workflows/server/store.ts: change the texts with them), credentials, and webhook requests (headers incl. the
  forwarded IP; art. 14 data of callers, basis 6(1)(f)); § 4 recipients the workflows contact under the user's own
  relationship; Terms § 7.9–7.10 (no spam, attacks, phishing pages, credentials without right) and § 8.5–8.6 (AI nodes;
  the user discloses AI to people a workflow lets talk to a model, AI Act art. 50(1)).

