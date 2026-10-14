"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { CopyButton, Field, KeyValues, Notice, Panel, Select, TextInput } from "@/components/ui";

/**
 * Epoch ⇄ calendar time. No date library: `Date` plus `Intl.DateTimeFormat`
 * for real IANA zones. A bare number is read as seconds below 1e12 and as
 * milliseconds above it, which is what people actually mean in practice.
 */

const ZONES = [
  "UTC",
  "Europe/Warsaw",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Kolkata",
  "Australia/Sydney",
] as const;

function subscribeToClock(onStoreChange: () => void) {
  const timer = setInterval(onStoreChange, 1000);
  return () => clearInterval(timer);
}

function getClockSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

function getServerClockSnapshot(): null {
  return null;
}

function getLocalZoneSnapshot(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function getServerLocalZoneSnapshot(): string {
  return "UTC";
}

function subscribeToLocalZone(): () => void {
  return () => {};
}

function wallClock(seconds: number, zone: string): string {
  const stamp = new Date(seconds * 1000);
  if (Number.isNaN(stamp.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: zone,
    }).format(stamp);
  } catch {
    return "unknown zone";
  }
}

function parseInput(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    return Math.abs(n) < 1e12 ? n : n / 1000;
  }
  // ISO-ish: try the platform parser, then a bare "YYYY-MM-DD".
  const normalized = value.includes("T") && !/[Z+]|-\d{2}:\d{2}$/.test(value) ? `${value}Z` : value;
  const stamp = new Date(normalized);
  const seconds = stamp.getTime();
  return Number.isNaN(seconds) ? null : seconds / 1000;
}

function breakdown(seconds: number): string {
  const abs = Math.abs(seconds);
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = Math.floor(abs % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

/** ISO-8601 week number (weeks start Monday, week 1 holds Jan 4th). */
function isoWeek(stamp: Date): number {
  const local = new Date(Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate()));
  const day = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(local.getUTCFullYear(), 0, 1);
  return Math.ceil(((local.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function dayOfYear(stamp: Date): number {
  const start = Date.UTC(stamp.getUTCFullYear(), 0, 0);
  return Math.floor((stamp.getTime() - start) / 86_400_000);
}

export default function EpochTool() {
  const [raw, setRaw] = useState<string | null>(null);
  const [zone, setZone] = useState("Europe/Warsaw");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const now = useSyncExternalStore(subscribeToClock, getClockSnapshot, getServerClockSnapshot);
  const localZone = useSyncExternalStore(subscribeToLocalZone, getLocalZoneSnapshot, getServerLocalZoneSnapshot);
  const currentInput = raw ?? (now === null ? "" : String(now));

  const seconds = useMemo(() => parseInput(currentInput), [currentInput]);
  const startSeconds = useMemo(() => parseInput(start), [start]);
  const endSeconds = useMemo(() => parseInput(end), [end]);

  const rows: [string, string][] = useMemo(() => {
    if (seconds === null) return [];
    const stamp = new Date(seconds * 1000);
    return [
      ["Unix seconds", String(Math.floor(seconds))],
      ["Unix milliseconds", String(Math.floor(seconds * 1000))],
      ["ISO 8601 UTC", stamp.toISOString()],
      ["Your zone", wallClock(seconds, localZone)],
      ["Selected zone", wallClock(seconds, zone)],
      ["Offset from now", now === null ? "—" : `${breakdown(seconds - now)} ${seconds >= now ? "ahead" : "behind"}`],
      ["Week / day-of-year", `W${isoWeek(stamp)} · day ${dayOfYear(stamp)}`],
    ];
  }, [localZone, now, seconds, zone]);

  const duration = useMemo(() => {
    if (startSeconds === null || endSeconds === null) return null;
    const delta = endSeconds - startSeconds;
    return { delta, human: breakdown(delta), signed: delta >= 0 ? "+" : "−" };
  }, [endSeconds, startSeconds]);

  return (
    <div className="space-y-4">
      <Panel
        title="Right now"
        right={<span className="font-mono text-[11px] text-faint">ticks every second</span>}
      >
        <KeyValues
          rows={[
            ["Unix seconds", now === null ? "—" : String(now)],
            ["Unix milliseconds", now === null ? "—" : String(now * 1000)],
            ["ISO 8601 UTC", now === null ? "—" : new Date(now * 1000).toISOString()],
            [`Your zone (${localZone})`, now === null ? "—" : wallClock(now, localZone)],
          ]}
        />
        <div className="flex flex-wrap gap-1.5">
          <CopyButton text={now === null ? "" : String(now)} label="Copy epoch" />
        </div>
      </Panel>

      <Panel title="Convert">
        <div className="space-y-3">
          <Field label="Epoch or ISO date" hint="A number under 1e12 is seconds; above it is milliseconds. Dates may carry an explicit offset.">
            <TextInput
              value={currentInput}
              spellCheck={false}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="1790000000 · 2026-10-01T12:00Z"
              className="font-mono"
            />
          </Field>

          <div className="flex flex-wrap items-end gap-2">
            <Field label="Zone" className="w-40">
              <Select value={zone} onChange={(e) => setZone(e.target.value)}>
                {ZONES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {currentInput.trim() && seconds === null ? (
            <Notice tone="error">That is neither a number nor a date this browser can read.</Notice>
          ) : null}

          {seconds !== null ? (
            <div className="space-y-2">
              <KeyValues rows={rows} />
              <div className="flex flex-wrap gap-1.5">
                <CopyButton text={String(Math.floor(seconds))} label="Copy seconds" />
                <CopyButton text={new Date(seconds * 1000).toISOString()} label="Copy ISO" />
              </div>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Duration"
        right={
          duration
            ? <span className="font-mono text-[11px] text-faint">{duration.human}</span>
            : undefined
        }
      >
        <div className="space-y-3">
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="From">
              <TextInput
                value={start}
                spellCheck={false}
                onChange={(e) => setStart(e.target.value)}
                placeholder="epoch or date"
                className="font-mono"
              />
            </Field>
            <Field label="To">
              <TextInput
                value={end}
                spellCheck={false}
                onChange={(e) => setEnd(e.target.value)}
                placeholder="epoch or date"
                className="font-mono"
              />
            </Field>
          </div>

          {duration ? (
            <div className="space-y-2">
              <KeyValues
                rows={[
                  ["Elapsed", `${duration.signed}${duration.human}`],
                  ["Seconds", String(Math.round(duration.delta))],
                  ["Milliseconds", String(Math.round(duration.delta * 1000))],
                ]}
              />
              <CopyButton text={String(Math.round(duration.delta))} label="Copy seconds" />
            </div>
          ) : (
            <p className="text-xs text-faint">
              Fill both sides — epochs and dates mix freely.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
