"use client";

import { useEffect, useState } from "react";
import { cx } from "@/lib/format";

type Mode = "light" | "dark";
const KEY = "sk-theme";
const ORDER: Mode[] = ["dark", "light"];

function readMode(): Mode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(mode: Mode) {
  const root = document.documentElement;
  root.dataset.theme = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage blocked: the choice just lasts for this page */
  }
}

const ICONS: Record<Mode, string> = {
  light:
    "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z",
  dark: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z",
};

const LABELS: Record<Mode, string> = {
  light: "Theme: light",
  dark: "Theme: dark",
};

export function ThemeToggle({ className }: { className?: string }) {
  const [mode, setMode] = useState<Mode>("dark");

  useEffect(() => {
    // Hydrate from storage after mount so server and client markup agree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(readMode());
  }, []);

  const next = () => {
    const nextMode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    setMode(nextMode);
    apply(nextMode);
  };

  return (
    <button
      autoComplete="off"
      type="button"
      onClick={next}
      aria-label={`${LABELS[mode]} (click to change)`}
      title={LABELS[mode]}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-muted shadow-xs transition-colors hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={ICONS[mode]} />
      </svg>
    </button>
  );
}
