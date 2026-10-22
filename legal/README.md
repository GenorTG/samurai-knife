# Legal pages (defaults)

The Terms of Service (`/terms`) and the privacy notice (`/privacy`) of an instance, in Polish (binding) and English.
They describe what Smart Knife actually stores, where, for how long and on which legal basis, and the notices a private,
non-commercial operator in Poland gives (GDPR art. 13/14, UŚUDE art. 8 regulamin content, DSA art. 11–18, AI Act
art. 50, Polish electronic-communications law art. 399). Research notes and sources: docs/LEGAL.md.

**These files are defaults. Every instance has its own operator, so do not edit them for your instance:**

1. Copy `legal.example.json` to `$KNIFE_LEGAL_DIR/legal.json` (default `$KNIFE_DATA_DIR/legal/`; the install script
   uses `/etc/samurai-knife/legal/`) and put in your details. Until every placeholder has a value the pages show a
   warning and the gaps are visible.
2. Only if the defaults do not fit your instance (other features, other processors, other retention): copy the page you
   need, e.g. `terms.pl.md`, into the same directory and edit it there. An instance file replaces the default page.
3. Any change of text or details is a new version (a fingerprint), which new sign-ups accept and which is stored on the
   account. The instance keeps every version it has shown in `$KNIFE_DATA_DIR/legal-history/` (exact texts and the day
   each was first shown): the pages list them under "Earlier versions" and `?version=<fingerprint>` reads one, so what a
   person accepted stays readable. Announce changes to existing users as the Terms say (e-mail, notice period): for
   accounts created earlier a changed Terms text applies only `changeNoticeDays` after it was first shown, and the
   Terms page says so.

## Versions and editions

- **Edition**: a release of these default texts. `versions.json` lists every edition (number, date, the Smart Knife
  version it shipped in, a digest of the four files) and what the current one covers (every cookie the app sets, every
  per-account storage area); `editions/<n>/` keeps the texts of earlier editions, readable as `?edition=<n>`. The
  texts themselves describe their history: Terms § 17, privacy notice § 15 (with a table of what each Smart Knife
  version added).
- **Version** (fingerprint): one instance's rendered texts (edition + its `legal.json`, or its own pages). Changing the
  address in `legal.json` is a new version of the same edition. The effective date is not part of it.
- A new release can bring a new edition. Its texts never claim an earlier date: the page shows `effectiveDate` or the
  day this instance first showed the version, whichever is later.

Placeholders (`{{name}}`): every key of `legal.example.json`, plus `siteName` (default "Smart Knife"), `siteUrl` (from
`KNIFE_PUBLIC_URL`) and `minimumAge` (default 16).

| Key | What to put there |
|---|---|
| `operatorName` | your full name (the controller and the service provider) |
| `contactEmail` | one address for users, authorities and data-protection requests |
| `postalAddress` | an address for correspondence: see docs/LEGAL.md "Postal address" before you decide |
| `effectiveDate` | optional: the earliest date the texts apply from (for example a future date for an announced change); a version never applies before the day this instance first showed it |
| `minimumAge` | 16 (GDPR default in Poland) or 18 |
| `mailRelay` | who relays your outgoing mail, with the country, e.g. "netcup GmbH (Germany)"; your processor (sign its DPA) |
| `backupRetentionDays` | after how many days backups are overwritten |
| `logRetentionDays` | the longest time any technical log (app, mail, reverse proxy) is kept; make it true |
| `complaintDays`, `changeNoticeDays`, `shutdownNoticeDays` | response time for complaints, notice before changes take effect, notice before closing an account or the service |

Not legal advice. Have a lawyer (radca prawny or adwokat) review your texts if anything is at stake.
