"use client";

/**
 * The editor's right-click menu: placed at the pointer and kept inside the window, arrow keys + Enter + Escape, closes
 * on an outside press, a scroll of the page or the window losing focus. Items run, then the menu closes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";

export type MenuEntry =
  | { kind?: "item"; label: string; hint?: string; danger?: boolean; disabled?: boolean; run: () => void }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

export function ContextMenu({ x, y, label, entries, onClose }: { x: number; y: number; label: string; entries: MenuEntry[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState({ left: x, top: y });
  const items = entries.flatMap((entry, index) => (entry.kind === "separator" || entry.kind === "heading" || entry.disabled ? [] : [index]));
  const [active, setActive] = useState(items[0] ?? -1);

  // Keep the whole menu on screen (open left/up from the pointer near the right/bottom edge).
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setSpot({ left: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
    menu.current?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    const away = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("wheel", away, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const choose = (index: number) => {
    const entry = entries[index];
    if (!entry || entry.kind === "separator" || entry.kind === "heading" || entry.disabled) return;
    onClose();
    entry.run();
  };

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-workflow-menu
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const at = items.indexOf(active);
        if (event.key === "Escape") onClose();
        else if (event.key === "ArrowDown") setActive(items[(at + 1) % items.length]);
        else if (event.key === "ArrowUp") setActive(items[(at - 1 + items.length) % items.length]);
        else if (event.key === "Home") setActive(items[0]);
        else if (event.key === "End") setActive(items[items.length - 1]);
        else if (event.key === "Enter" || event.key === " ") choose(active);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ left: spot.left, top: spot.top }}
      className="sk-pop fixed z-[80] min-w-56 rounded-lg border border-line-strong bg-surface p-1 shadow-pop outline-none"
    >
      {entries.map((entry, index) =>
        entry.kind === "separator" ? (
          <div key={index} role="separator" className="my-1 h-px bg-line" />
        ) : entry.kind === "heading" ? (
          <p key={index} className="truncate px-2.5 pt-1.5 pb-1 font-mono text-[10px] font-semibold tracking-[0.12em] text-faint uppercase">
            {entry.label}
          </p>
        ) : (
          <button
            autoComplete="off"
            key={index}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            tabIndex={-1}
            onMouseEnter={() => !entry.disabled && setActive(index)}
            onClick={() => choose(index)}
            className={cx(
              "flex w-full cursor-pointer items-center gap-6 rounded-md px-2.5 py-1.5 text-left text-[13px] disabled:cursor-default disabled:opacity-40",
              entry.danger ? "text-danger" : "text-ink",
              index === active && !entry.disabled && (entry.danger ? "bg-danger/12" : "bg-accent/12"),
            )}
          >
            <span className="flex-1">{entry.label}</span>
            {entry.hint ? <kbd className="font-mono text-[11px] text-faint">{entry.hint}</kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}
