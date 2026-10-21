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
- Version: legal.json `version`, else a hash over every rendered page. `GET /api/legal` returns it.
- Sign-up: one checkbox ("I accept the Terms … have read the privacy notice") gates the password form and "Sign up with
  GitHub". `POST /api/account/register` needs `acceptTerms` = the current version (400 `terms_required`, 409
  `terms_changed`); "Sign up with GitHub" carries it in the sealed OAuth state, and a new GitHub user who came from
  /login without it is sent to /register (`terms_required`). The account stores `termsAcceptedAt` and `termsVersion`
  (proof of what was accepted). Existing accounts, and accounts made with the CLI, have `null` there.
- The assistant widget says it is an AI system under the message box (AI Act art. 50(1)/(5)) and links to the Terms.
- Renderer (`src/lib/legal/legal.ts`): raw HTML in a text is shown as text, links only http(s)/mailto/same-site, no
  images, `## Heading {#id}` gives a stable anchor. Missing placeholders show as `[name?]` plus a warning on the page.
- Tests: `tests/legal.test.mjs`, the register/GitHub checks in `tests/github_app.test.mjs`,
  `tests/functional/accounts_public_e2e.py` and `tests/functional/github_app_e2e.py`.

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

- **ArtCraft apps** (`craft` sidecar, docs/SIDECARS.md "ArtCraft"): PhotoCraft, VectorCraft, FilmCraft, LightCraft,
  EffectCraft, DesignCraft, PdfCraft, FigCraft, WordCraft, SoundCraft, DeckCraft, CADCraft and GridCraft by storytold
  ("ArtCraft Team and the <app> contributors"), each MIT OR Apache-2.0. The instance redistributes their release zips
  unmodified (plus `.gz` copies) from its own server; each unpacked release keeps and serves its `LICENSE-MIT`,
  `LICENSE-APACHE` and, where the release has them, `NOTICE`, `ATTRIBUTION.md` (SoundCraft) and the SIL Open Font
  License 1.1 texts of the fonts FigCraft embeds (`OFL-*.txt`, Inter and 20 others) (Apache-2.0 §4, OFL §2), and the
  ArtCraft page names the licence and links the source. The bundled egui fonts (Ubuntu Font Licence 1.0, Hack MIT, Noto
  Emoji OFL-1.1) are inside the wasm under their own licences, listed in the apps' NOTICE/ATTRIBUTION files. The
  ArtCraft name, wordmark and logos are trademarks of the ArtCraft Team and not covered by the code licence: Smart
  Knife uses the names only to say which app a tab runs and shows none of their logos. Nothing of theirs is in this
  repository. nginx (the container) is BSD-2-Clause.
- Privacy notice, not changed automatically (a text change is a new legal version that existing users should hear
  about): an instance that offers ArtCraft would add two rows to "Cookies and browser storage": `knife_craft` (cookie on
  the ArtCraft host, only with `KNIFE_CRAFT_PUBLIC_URL`: lets the browser load the apps, up to 12 hours) and the apps'
  own browser storage on the ArtCraft host (preferences, LightCraft's photo library, EffectCraft's projects and media,
  the documents the other apps keep for recovery, in local storage, IndexedDB or OPFS; kept until the user clears it;
  never sent to the server). Both are strictly necessary for a tool the user opens (art. 399 ust. 3 PKE). The office
  editor's `knife_office` cookie is missing from the table today too.

