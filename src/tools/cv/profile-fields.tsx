"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button } from "@/components/ui";
import type { AuditFinding } from "@/lib/cv/client";
import type { CvOp } from "@/lib/cv/ops";
import type { CvLang } from "@/lib/cv/schema";
import { cx } from "@/lib/format";

/** Everything the inline-edit fields of the Profile tab share. */
export interface ProfileEnv {
  lang: CvLang;
  other: CvLang;
  /** Translation filter: only fields missing in `lang` (and the items that hold them) are shown. */
  onlyMissing: boolean;
  missing: ReadonlySet<string>;
  findings: Record<string, AuditFinding[]>;
  /** Apply ops through POST /api/cv/patch. Resolves to the API's reason on failure, "" on success. */
  save: (ops: CvOp[], openAfter?: string) => Promise<string>;
  /** Path of a field to open for editing right after it was created. */
  autoEdit: string;
  /** Re-read the CV now (after a change made outside `save`, e.g. a project added from GitHub). */
  reload?: () => void;
}

const Env = createContext<ProfileEnv | null>(null);
export const ProfileEnvProvider = Env.Provider;

export function useProfileEnv(): ProfileEnv {
  const env = useContext(Env);
  if (!env) throw new Error("ProfileEnv missing");
  return env;
}

/** True when the translation filter is on and nothing under `prefix` is missing in the current language. */
export function useHidden(prefix: string): boolean {
  const env = useProfileEnv();
  if (!env.onlyMissing) return false;
  for (const path of env.missing) if (path === prefix || path.startsWith(`${prefix}/`)) return false;
  return true;
}

function findingsFor(env: ProfileEnv, path: string): AuditFinding[] {
  return env.findings[path] ?? env.findings[path.replace(/\/(pl|en)$/, "")] ?? [];
}

interface FieldProps {
  /** Full id-path of the string (or string list) this field edits. */
  path: string;
  value: string;
  /** Accessible name, e.g. "Acme bullet b2 text (EN)". */
  label: string;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  /** For string lists: edit as comma separated text. */
  list?: boolean;
  /** Same field in the other language, shown as a reference when this one is empty. */
  reference?: string;
  /** The bilingual field this edits: in the translation filter it shows only while this path is missing. */
  biPath?: string;
  /** Stay visible in the translation filter (item headings). */
  keepInFilter?: boolean;
  /** An empty value is stored as null (open end dates). */
  nullable?: boolean;
}

/**
 * Click to edit in place: the text becomes a textarea, Ctrl+Enter or blur saves (POST /api/cv/patch with an id-path set op),
 * Escape cancels, the API's 422 reason stays visible under the field. Audit findings for the path render underneath.
 */
export function EditableField({ path, value, label, placeholder, multiline = false, className, list = false, reference, biPath, keepInFilter = false, nullable = false }: FieldProps) {
  const env = useProfileEnv();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  // A freshly created field opens for typing once (derived-state pattern: adjust during render, no effect).
  const [openedFor, setOpenedFor] = useState("");
  if (env.autoEdit && env.autoEdit === path && openedFor !== path) {
    setOpenedFor(path);
    setDraft(value);
    setEditing(true);
  }

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft, editing]);

  useEffect(() => {
    if (editing) {
      area.current?.focus();
      area.current?.setSelectionRange(area.current.value.length, area.current.value.length);
    }
  }, [editing]);

  if (env.onlyMissing && !keepInFilter && !(biPath && env.missing.has(biPath))) return null;

  const open = () => {
    done.current = false;
    setDraft(value);
    setError("");
    setEditing(true);
  };

  const commit = async () => {
    if (done.current || saving) return;
    if (draft === value) {
      setEditing(false);
      setError("");
      return;
    }
    done.current = true;
    setSaving(true);
    const next: string | string[] | null = list ? draft.split(",").map((s) => s.trim()).filter(Boolean) : nullable && !draft.trim() ? null : draft;
    const reason = await env.save([{ op: "set", path, value: next }]);
    setSaving(false);
    if (reason) {
      done.current = false;
      setError(reason);
    } else {
      setError("");
      setEditing(false);
    }
  };

  const cancel = () => {
    done.current = true;
    setEditing(false);
    setError("");
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !multiline)) {
      event.preventDefault();
      void commit();
    }
  };

  const found = findingsFor(env, path);
  return (
    <div data-cv-path={path} className={cx("min-w-0 rounded-md", className)}>
      {editing ? (
        <div className="space-y-1.5">
          <textarea
            ref={area}
            rows={multiline ? 3 : 1}
            value={draft}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            disabled={saving}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
              // Talking to the assistant about this field (focus moves into its panel) must not close or save the editor.
              if (event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-agent-widget]")) return;
              void commit();
            }}
            onKeyDown={onKey}
            className="sk-input block w-full resize-none px-2.5 py-1.5 text-sm leading-relaxed"
          />
          {/* Explicit controls too: mouse and assistant users have no Ctrl+Enter. mousedown must not blur (= save) the field first. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="primary" aria-label={`Save ${label}`} disabled={saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void commit()}>Save</Button>
            <Button size="sm" variant="ghost" aria-label={`Cancel editing ${label}`} onMouseDown={(event) => event.preventDefault()} onClick={cancel}>Cancel</Button>
            <span className="hidden text-[11px] text-faint sm:inline">Ctrl+Enter saves · Esc cancels</span>
          </div>
        </div>
      ) : (
        <button
          autoComplete="off"
          type="button"
          aria-label={`Edit ${label}`}
          onClick={open}
          className={cx(
            "group block w-full cursor-text rounded-md border border-transparent px-2.5 py-1 text-left text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap transition-colors hover:border-line-strong hover:bg-raised/60",
            value ? "text-ink" : "text-faint italic",
          )}
        >
          {value || placeholder || "Click to write"}
          <span aria-hidden className="ml-1.5 text-xs text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">✎</span>
        </button>
      )}
      {!value && !editing && reference ? <p className="px-2.5 pb-1 text-xs text-faint wrap-anywhere"><span className="sk-label">{env.other}</span> {reference}</p> : null}
      {error ? <p role="alert" className="px-2.5 pt-1 text-xs text-danger wrap-anywhere">{error}</p> : null}
      {found.length > 0 ? (
        <ul className="space-y-1 px-2.5 pt-1" aria-label={`Findings for ${label}`}>
          {found.map((f, i) => (
            <li key={`${f.rule}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-xs text-warn">
              <Badge tone="warn">{f.rule}</Badge>
              <span className="min-w-0 wrap-anywhere">{f.message}{f.fix ? <> <b className="font-semibold text-ink">Tip:</b> {f.fix}</> : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Row with a name + inline add form (`Add <thing>`), used to append list items. */
export function AddRow({ label, buttonLabel, placeholder, onAdd }: { label: string; buttonLabel: string; placeholder: string; onAdd: (name: string) => Promise<string> }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const reason = await onAdd(name.trim());
    setBusy(false);
    setError(reason);
    if (!reason) setName("");
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label={label}
          value={name}
          placeholder={placeholder}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          className="sk-input h-8 min-w-0 flex-1 basis-40 px-2.5 text-sm"
        />
        <Button size="sm" onClick={() => void submit()} disabled={!name.trim() || busy}>{buttonLabel}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger wrap-anywhere">{error}</p> : null}
    </div>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button size="sm" variant="ghost" aria-label={label} onClick={onClick} className="text-faint hover:text-danger">Remove</Button>;
}

export function ItemCard({ children, path, title, right }: { children: ReactNode; path: string; title?: ReactNode; right?: ReactNode }) {
  return (
    <article data-cv-path={path} className="min-w-0 rounded-xl border border-line bg-raised/30 p-3">
      {title || right ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm font-semibold text-ink">{title}</div>
          {right}
        </div>
      ) : null}
      {children}
    </article>
  );
}

/** Priority toggle: a pinned item is always kept and listed first when a CV version is tailored for an offer. */
export function PinButton({ path, pinned, name }: { path: string; pinned: boolean; name: string }) {
  const env = useProfileEnv();
  if (env.onlyMissing) return null;
  return (
    <button
      autoComplete="off"
      type="button"
      aria-pressed={pinned}
      aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
      title="Pinned = priority: always included and listed first in tailored versions"
      onClick={() => void env.save([{ op: "set", path: `${path}/pinned`, value: !pinned }])}
      className="cursor-pointer"
    >
      <Badge tone={pinned ? "accent" : "neutral"}>{pinned ? "★ pinned" : "☆ pin"}</Badge>
    </button>
  );
}
