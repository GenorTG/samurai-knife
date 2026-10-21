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
3. Any change of text or details is a new version (a hash), which new sign-ups accept and which is stored on the
   account. Announce changes to existing users as the Terms say (e-mail, notice period).

Placeholders (`{{name}}`): every key of `legal.example.json`, plus `siteName` (default "Smart Knife"), `siteUrl` (from
`KNIFE_PUBLIC_URL`) and `minimumAge` (default 16).

| Key | What to put there |
|---|---|
| `operatorName` | your full name (the controller and the service provider) |
| `contactEmail` | one address for users, authorities and data-protection requests |
| `postalAddress` | an address for correspondence: see docs/LEGAL.md "Postal address" before you decide |
| `effectiveDate` | the date the current texts apply from |
| `minimumAge` | 16 (GDPR default in Poland) or 18 |
| `mailRelay` | who relays your outgoing mail, with the country, e.g. "netcup GmbH (Germany)"; your processor (sign its DPA) |
| `backupRetentionDays` | after how many days backups are overwritten |
| `logRetentionDays` | the longest time any technical log (app, mail, reverse proxy) is kept; make it true |
| `complaintDays`, `changeNoticeDays`, `shutdownNoticeDays` | response time for complaints, notice before changes take effect, notice before closing an account or the service |

Not legal advice. Have a lawyer (radca prawny or adwokat) review your texts if anything is at stake.
