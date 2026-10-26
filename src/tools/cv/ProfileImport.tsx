"use client";

import { msgf } from "@/lib/i18n/msg";
import { useState } from "react";
import { Button, CopyButton, Field, Notice, Panel, TextArea } from "@/components/ui";
import { errorText, importCv } from "@/lib/cv/client";
import type { Profile } from "@/lib/cv/schema";
import { useT } from "@/lib/i18n/react";

const EXAMPLE = JSON.stringify(
  {
    contact: { name: "Alex Example", headline: { pl: "Inżynier oprogramowania", en: "Software engineer" }, email: "alex@example.com", links: [] },
    summary: { pl: "", en: "Engineer focused on reliable web tools." },
    experience: [
      {
        id: "acme", org: "Acme Ltd", role: { pl: "", en: "Engineer" }, start: "2022-01", end: null,
        bullets: [{ id: "acme-api", text: { pl: "", en: "Built an internal API used by three teams." } }],
      },
    ],
    skills: [{ id: "languages", name: { pl: "Języki", en: "Languages" }, items: ["TypeScript", "Python"] }],
  },
  null,
  2,
);

function describeJsonError(text: string, error: unknown): string {
  const message = errorText(error);
  const at = /position (\d+)/.exec(message);
  if (!at) return msgf("That is not valid JSON: {message}", { message });
  const before = text.slice(0, Number(at[1]));
  const line = before.split("\n").length;
  return msgf("That is not valid JSON (line {line}): {message}", { line, message });
}

/** Paste a JSON profile -> POST /api/cv/import. With an existing profile, replacing needs an explicit second click. */
export function ProfileImport({ existing, onImported, onCancel }: { existing: Profile | null; onImported: () => void; onCancel?: () => void }) {
  const { t, m } = useT();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (overwrite: boolean) => {
    let profile: unknown;
    try {
      profile = JSON.parse(text);
    } catch (e) {
      setError(m(describeJsonError(text, e)));
      setConfirming(false);
      return;
    }
    setBusy(true);
    try {
      await importCv(profile, overwrite);
      setError("");
      setConfirming(false);
      setText("");
      onImported();
    } catch (e) {
      setError(errorText(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!text.trim()) {
      setError(t("Paste a JSON profile first."));
      return;
    }
    if (existing && !confirming) {
      setError("");
      setConfirming(true);
      return;
    }
    void run(existing !== null);
  };

  return (
    <Panel
      title={existing ? t("Replace the profile") : t("Import your profile")}
      right={existing ? <CopyButton text={JSON.stringify(existing, null, 2)} label={t("Copy current profile JSON")} /> : undefined}
    >
      <div className="space-y-3" data-agent-region="cv-import">
        <p className="text-[13px] leading-relaxed text-muted">
          {t("Paste a complete profile as JSON (every text field is")}{" "} {t("{ \"pl\": …, \"en\": … }")}{t("). Don't have one? Ask the assistant to structure your CV text, or start from the example.")}
        </p>
        <Field label={t("Profile JSON")}>
          <TextArea
            rows={10}
            value={text}
            spellCheck={false}
            placeholder={t("{ \"contact\": { \"name\": \"…\" }, \"experience\": [ … ] }")}
            onChange={(event) => {
              setText(event.target.value);
              setConfirming(false);
            }}
          />
        </Field>
        {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
        {confirming ? (
          <Notice tone="warn">{t("A profile already exists. Importing replaces all of it (you can still undo right after). Press \"Confirm replace\" to continue.")}</Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant={confirming ? "danger" : "primary"} onClick={submit} disabled={busy}>
            {confirming ? t("Confirm replace") : existing ? t("Replace profile") : t("Import profile")}
          </Button>
          <Button onClick={() => { setText(EXAMPLE); setConfirming(false); setError(""); }}>{t("Insert example")}</Button>
          {onCancel ? <Button variant="ghost" onClick={onCancel}>{t("Cancel")}</Button> : null}
        </div>
      </div>
    </Panel>
  );
}
