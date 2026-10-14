"use client";

import { useEffect, useRef } from "react";
import { cx } from "@/lib/format";
import { useToolPreferences } from "@/lib/tool-preferences";

export function FavoriteButton({
  toolName,
  favorite,
  onToggle,
  disabled = false,
  className,
}: {
  toolName: string;
  favorite: boolean;
  onToggle: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const label = favorite
    ? `Remove ${toolName} from favorites`
    : `Add ${toolName} to favorites`;

  return (
    <button
      autoComplete="off"
      type="button"
      aria-label={label}
      aria-pressed={favorite}
      title={`${label}. Saved only in this browser.`}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-base shadow-xs transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        favorite
          ? "border-accent/50 bg-accent/12 text-accent-soft"
          : "border-line bg-surface text-muted hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
    </button>
  );
}

export function ToolActions({ tool }: { tool: { slug: string; name: string } }) {
  const { favorites, ready, toggleFavorite, recordRecent } = useToolPreferences();
  const recordedSlug = useRef("");
  const favorite = favorites.includes(tool.slug);

  useEffect(() => {
    if (!ready || recordedSlug.current === tool.slug) return;
    recordedSlug.current = tool.slug;
    recordRecent(tool.slug);
  }, [ready, recordRecent, tool.slug]);

  return (
    <FavoriteButton
      toolName={tool.name}
      favorite={favorite}
      onToggle={() => toggleFavorite(tool.slug)}
      disabled={!ready}
    />
  );
}
