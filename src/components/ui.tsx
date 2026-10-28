"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type Ref,
  type RefObject,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import Link from "next/link";
import { cx, copyText, formatBytes } from "@/lib/format";
import { commitDraftValue, liveDraftValue, type NumberDraftSpec } from "@/lib/number-draft";
import { useT } from "@/lib/i18n/react";

/* ---------------------------------------------------------------- buttons */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "subtle" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
};

function buttonClass(variant: NonNullable<ButtonProps["variant"]>, size: NonNullable<ButtonProps["size"]>, className?: string): string {
  const variants = {
    primary:
      "sk-btn-primary bg-accent text-accent-fg border border-transparent font-semibold hover:brightness-110 active:brightness-95",
    subtle:
      "bg-surface text-ink border border-line-strong shadow-xs hover:bg-raised hover:border-faint active:bg-raised",
    ghost:
      "text-muted border border-transparent hover:bg-raised hover:text-ink",
    danger:
      "bg-surface text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger/70",
  };
  const sizes = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-9 px-3.5 text-sm",
    lg: "h-11 px-5 text-[15px]",
  };
  return cx(
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg whitespace-nowrap transition-[background-color,border-color,color,filter] duration-150 select-none",
    "disabled:cursor-not-allowed disabled:opacity-40",
    variants[variant],
    sizes[size],
    className,
  );
}

export function Button({
  variant = "subtle",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return <button autoComplete="off" type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

/** A navigation link that looks like a Button (calls to action). `external`: another site, opened in a new tab. */
export function ButtonLink({
  href,
  variant = "subtle",
  size = "md",
  className,
  external = false,
  children,
}: {
  href: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  external?: boolean;
  children: ReactNode;
}) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass(variant, size, className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  disabled = false,
}: {
  text: string;
  label?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
}) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <Button
      size={size}
      variant={done ? "primary" : "subtle"}
      disabled={disabled || !text}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        }
      }}
    >
      {done ? t("Copied") : t(label)}
    </Button>
  );
}

/*
 * In-page full screen: one element at a time covers the whole page (sidebar, top bar and assistant stay behind it) while
 * staying in the page, so drawers and dialogs rendered inside it keep working (a Craft app's file chooser, "My files").
 * Not the browser's Fullscreen API: that shows the element alone and loses everything around it. The element gets
 * `data-page-fullscreen` (globals.css lays it out), a child marked `data-page-fill` takes the remaining height.
 */
let pageFullscreenElement: HTMLElement | null = null;
const pageFullscreenListeners = new Set<() => void>();

export function setPageFullscreen(element: HTMLElement | null): void {
  if (pageFullscreenElement === element) return;
  pageFullscreenElement?.removeAttribute("data-page-fullscreen");
  pageFullscreenElement = element;
  if (element) {
    element.setAttribute("data-page-fullscreen", "");
    document.documentElement.setAttribute("data-page-fullscreen", "");
  } else {
    document.documentElement.removeAttribute("data-page-fullscreen");
  }
  for (const listener of pageFullscreenListeners) listener();
}

function subscribePageFullscreen(onChange: () => void): () => void {
  pageFullscreenListeners.add(onChange);
  return () => pageFullscreenListeners.delete(onChange);
}

/** Whether `target` fills the page, and the switch. Esc leaves (unless a dialog is open: Esc closes that first); unmounting leaves too. */
export function usePageFullscreen(target: RefObject<HTMLElement | null>): { active: boolean; enter: () => void; exit: () => void } {
  const active = useSyncExternalStore(subscribePageFullscreen, () => pageFullscreenElement !== null && pageFullscreenElement === target.current, () => false);
  useEffect(() => {
    if (!active) return;
    const element = target.current;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) setPageFullscreen(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (pageFullscreenElement === element && !element?.isConnected) setPageFullscreen(null);
    };
  }, [active, target]);
  useEffect(() => () => {
    if (pageFullscreenElement && !pageFullscreenElement.isConnected) setPageFullscreen(null);
  }, []);
  return {
    active,
    enter: () => setPageFullscreen(target.current),
    exit: () => {
      if (pageFullscreenElement === target.current) setPageFullscreen(null);
    },
  };
}

/** Full screen inside the page for `target` (see usePageFullscreen); the same button leaves it. */
export function FullscreenButton({ target, size = "sm", label = "Full screen" }: { target: RefObject<HTMLElement | null>; size?: ButtonProps["size"]; label?: string }) {
  const { t } = useT();
  const { active, enter, exit } = usePageFullscreen(target);
  return (
    <Button size={size} aria-pressed={active} title={active ? t("Back to the page (Esc)") : t("Fill the page with it; Esc or Exit full screen comes back")} onClick={active ? exit : enter}>
      {active ? t("Exit full screen") : t(label)}
    </Button>
  );
}

/* ----------------------------------------------------------------- inputs */

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx("sk-input h-10 w-full px-3 text-sm", className)}
      {...rest}
    />
  );
}

type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max" | "type"> &
  NumberDraftSpec & {
    value: number;
    /** Called with the clamped value on every parseable keystroke and again when editing ends. */
    onValueChange: (value: number) => void;
    /** "text" keeps a plain numeric-keyboard field (no spinner) for tools that never used type=number. */
    type?: "number" | "text";
  };

/**
 * Numeric input that never fights the typist: the raw text is kept while the field is focused
 * (so `1.5` or `40` can be typed key by key), the clamped value is published for computation as
 * soon as the text parses, and blur/Enter normalises the text to the clamped value (blank -> fallback).
 */
export function NumberField({ value, onValueChange, min, max, integer, fallback, type = "number", className, onBlur, onKeyDown, ...rest }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const spec: NumberDraftSpec = { min, max, integer, fallback };
  const commit = (text: string) => {
    if (draft === null) return;
    onValueChange(commitDraftValue(text, spec));
    setDraft(null);
  };
  return (
    <input
      {...rest}
      type={type}
      inputMode={type === "text" ? "numeric" : rest.inputMode}
      min={type === "number" && Number.isFinite(min) ? min : undefined}
      max={type === "number" && Number.isFinite(max) ? max : undefined}
      className={cx("sk-input h-10 w-full px-3 text-sm", className)}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value);
        const live = liveDraftValue(e.target.value, spec);
        if (live !== null) onValueChange(live);
      }}
      onBlur={(e) => {
        commit(e.target.value);
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        onKeyDown?.(e);
      }}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return (
    <textarea
      className={cx(
        "sk-input w-full px-3 py-2.5 font-mono text-[13px] leading-relaxed",
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  // autoComplete="off": Firefox restores a form control's dynamic state (disabled, the picked option) across reloads
  // before React hydrates; off keeps the server's markup (docs/ARCHITECTURE.md, the Firefox reload rule).
  return (
    <select autoComplete="off" className={cx("sk-input h-10 w-full px-3 text-sm", className)} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  return (
    <label className={cx("block space-y-1.5", className)}>
      <span className="sk-label block">{t(label)}</span>
      {children}
      {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/* --------------------------------------------------------------- surfaces */

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx(
        "min-w-0 rounded-tool border border-line bg-surface shadow-card",
        className,
      )}
    >
      {title || right ? (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          {right}
        </header>
      ) : null}
      <div className={cx("p-4 sm:p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "good" | "warn";
  children: ReactNode;
}) {
  // a plain message (often a server error) shows in the interface language when the catalogue knows it
  const { m } = useT();
  const tones = {
    info: "border-line-strong bg-raised/60 text-muted",
    error: "border-danger/40 bg-danger/10 text-danger",
    good: "border-good/40 bg-good/10 text-good",
    warn: "border-warn/40 bg-warn/10 text-warn",
  };
  return (
    <p
      className={cx(
        "rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed",
        tones[tone],
      )}
    >
      {typeof children === "string" ? m(children) : children}
    </p>
  );
}

/**
 * Live line for worker-backed tools: role=status text with the elapsed time and a Cancel button, shown once the work has
 * run for 300 ms (quick runs never flash it). Pair with `useOffloaded` (src/lib/workers/use-offloaded.ts).
 */
export function WorkStatus({
  running,
  elapsedMs,
  label,
  detail,
  cancelLabel = "Cancel",
  onCancel,
}: {
  running: boolean;
  elapsedMs: number;
  /** What is running, e.g. "Formatting JSON". */
  label: string;
  detail?: string;
  /** Names the action, e.g. "Cancel formatting". */
  cancelLabel?: string;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div role="status" aria-live="polite" data-agent-region="work-status">
      {running && elapsedMs > 300 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-raised/60 px-3 py-2 text-sm text-muted">
          <span className="min-w-0 flex-1">
            {t("{label}… {value} s elapsed", { label, value: (elapsedMs / 1000).toFixed(1) })}{detail ? `, ${detail}` : ""}{t(". The page stays usable.")}
          </span>
          <Button size="sm" variant="danger" onClick={onCancel}>{cancelLabel}</Button>
        </div>
      ) : null}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  const { t } = useT();
  return (
    <div className="min-w-0 rounded-lg border border-line bg-raised/50 px-3 py-2.5">
      <div className="sk-label line-clamp-2 wrap-anywhere" title={typeof label === "string" ? t(label) : undefined}>{t(label)}</div>
      <div className="mt-1 font-mono text-[15px] font-medium text-ink tabular-nums wrap-anywhere">{value}</div>
    </div>
  );
}

/** Row of Stats that reflows to the width of its own container (viewport breakpoints lie when the assistant is docked). */
export function StatGrid({ children, className, "aria-label": ariaLabel }: { children: ReactNode; className?: string; "aria-label"?: string }) {
  return <div role={ariaLabel ? "group" : undefined} aria-label={ariaLabel} className={cx("grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2", className)}>{children}</div>;
}

/** Label / value rows. Labels are interface texts (translated here; callers pass the English); values are data. */
export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  const { t } = useT();
  return (
    <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {rows.map(([key, value]) => (
        <div key={key} className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-3 px-3 py-2 text-sm">
          <dt className="text-faint">{t(key)}</dt>
          <dd className="font-mono text-[13px] break-words [overflow-wrap:anywhere] text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------------- dropzone */

export function Dropzone({
  accept,
  multiple = false,
  hint,
  onFiles,
  disabled,
}: {
  accept?: string;
  multiple?: boolean;
  hint?: ReactNode;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const id = useId();
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={cx(
        "rounded-tool border-2 border-dashed px-4 py-8 text-center transition-colors",
        over
          ? "border-accent bg-accent/10"
          : "border-line-strong bg-raised/40 hover:border-accent/60 hover:bg-accent/5",
        disabled && "opacity-50",
      )}
    >
      <input
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
      <label
        htmlFor={id}
        className="block cursor-pointer text-sm text-muted hover:text-ink"
      >
        <span className="font-medium text-accent-soft">{t("Choose file")}{multiple ? "s" : ""}</span>
        <span className="block text-xs text-faint">
          {hint ?? t("or drop it here")}
        </span>
      </label>
    </div>
  );
}

/* ----------------------------------------------------------------- output */

export function OutputBlock({
  value,
  rows = 14,
  empty = "Nothing yet.",
}: {
  value: string;
  rows?: number;
  empty?: string;
}) {
  return (
    <pre
      className="sk-input max-h-[60vh] overflow-auto px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words"
      style={{ minHeight: `${rows * 1.25}rem` }}
    >
      {value || <span className="text-faint">{empty}</span>}
    </pre>
  );
}

/* ----------------------------------------------------- badges, segments, empty states, drawers */

export function Badge({
  tone = "neutral",
  children,
  className,
  title,
}: {
  tone?: "neutral" | "accent" | "good" | "warn" | "danger";
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: "border-line-strong bg-raised text-muted",
    accent: "border-accent/40 bg-accent/10 text-accent-soft",
    // Text leans 20% toward the ink colour so the tinted pill keeps >= 4.5:1 in both themes.
    good: "border-good/40 bg-good/10 text-[color-mix(in_oklab,var(--c-good)_80%,var(--c-ink))]",
    warn: "border-warn/40 bg-warn/10 text-[color-mix(in_oklab,var(--c-warn)_80%,var(--c-ink))]",
    danger: "border-danger/40 bg-danger/10 text-[color-mix(in_oklab,var(--c-danger)_80%,var(--c-ink))]",
  };
  return (
    <span
      title={title}
      className={cx("inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium wrap-anywhere", tones[tone], className)}
    >
      {children}
    </span>
  );
}

/** Small exclusive choice (language PL | EN, theme…): a radiogroup of buttons with arrow-key movement. */
/**
 * Arrow keys for a hand-built radio group (role=radiogroup of role=radio buttons, e.g. a gallery of cards): moves the
 * selection to the next/previous radio of the same group, wrapping, and focuses it. Pair with a roving tabIndex
 * (0 on the checked radio, -1 on the others), as SegmentedControl does.
 */
export function radioGroupKeys(event: KeyboardEvent<HTMLElement>): void {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].filter((el) => el.closest('[role="radiogroup"]') === group);
  const index = radios.indexOf(event.currentTarget);
  if (index < 0 || radios.length < 2) return;
  event.preventDefault();
  const next = radios[(index + step + radios.length) % radios.length];
  next.click();
  next.focus();
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; ariaLabel?: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const { t } = useT();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex rounded-lg border border-line-strong bg-field p-0.5", className)}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            autoComplete="off"
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cx(
              "h-7 cursor-pointer rounded-md px-3 text-xs font-semibold transition-colors",
              selected ? "bg-accent text-accent-fg shadow-xs" : "text-muted hover:bg-raised hover:text-ink",
            )}
          >
            {typeof option.label === "string" ? t(option.label) : option.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-tool border border-dashed border-line-strong bg-raised/30 px-5 py-9 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1.5 max-w-prose text-[13px] leading-relaxed text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Thin labelled meter (coverage %, repo score). `value` is 0-100. */
export function Meter({ value, label, tone }: { value: number; label: string; tone?: "good" | "warn" | "danger" }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const auto = pct >= 70 ? "good" : pct >= 40 ? "warn" : "danger";
  const fill = { good: "bg-good", warn: "bg-warn", danger: "bg-danger" }[tone ?? auto];
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded-full bg-raised">
      <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Storage used against a quota ("12.3 MB of 1.0 GB used"), a bar that turns warn at 80 % and danger at 95 %. `quotaBytes`
 * null = unlimited (no bar). The text is the meter's accessible label, so automation reads the same numbers people see.
 */
export function StorageMeter({ usedBytes, quotaBytes, label = "Storage", compact = false }: { usedBytes: number; quotaBytes: number | null; label?: string; compact?: boolean }) {
  const text = quotaBytes === null ? `${formatBytes(usedBytes)} used · unlimited` : `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used`;
  const pct = quotaBytes === null ? 0 : quotaBytes === 0 ? 100 : Math.min(100, (usedBytes / quotaBytes) * 100);
  const fill = pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent";
  return (
    <div className={cx("min-w-0", compact ? "w-60 max-w-full" : "w-full")} data-agent-region="storage-meter">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-faint">{label}</span>
        <span className={cx("font-mono", pct >= 95 ? "text-danger" : "text-muted")}>{text}</span>
      </div>
      {quotaBytes !== null ? (
        <div
          role="meter"
          aria-label={`${label}: ${text}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-raised"
        >
          <div className={cx("h-full rounded-full transition-[width] duration-300", fill)} style={{ width: `${Math.max(pct, usedBytes > 0 ? 1 : 0)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Side sheet for add/edit forms. Stays inside the page DOM (not a portal) so the assistant's UI tools can see and drive it;
 * not modal (the page behind stays reachable), Escape closes it and the first field gets focus.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      // Sits left of the docked assistant (--sk-dock) so the two never overlap.
      style={{ right: "min(var(--sk-dock, 0px), 50vw)" }}
      className="sk-pop fixed inset-y-0 z-40 flex w-full max-w-md flex-col border-l border-line-strong bg-surface shadow-pop"
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t("Close {title}", { title })}>{t("Close")}</Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
      {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line py-3 pr-20 pl-4">{footer}</footer> : null}
    </div>
  );
}
