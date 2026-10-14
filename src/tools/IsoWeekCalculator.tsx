"use client";
import { useMemo, useState } from "react";
import { Field, Panel, Stat, StatGrid, TextInput } from "@/components/ui";
function isoParts(value: string) { const [year, month, day] = value.split("-").map(Number); const date = new Date(Date.UTC(year, month - 1, day)); if (date.toISOString().slice(0, 10) !== value) return null; const weekday = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - weekday); const weekYear = date.getUTCFullYear(); const yearStart = new Date(Date.UTC(weekYear, 0, 1)); const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7); return { weekYear, week, weekday: (new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7) }; }
export default function IsoWeekCalculator() {
  const [date, setDate] = useState("2026-10-03");
  const result = useMemo(() => { try { return isoParts(date); } catch { return null; } }, [date]);
  return <Panel title="ISO week calculator"><div className="space-y-3"><Field label="Calendar date"><TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>{result ? <StatGrid><Stat label="ISO week" value={`${result.weekYear}-W${String(result.week).padStart(2, "0")}`} /><Stat label="Week-year" value={result.weekYear} /><Stat label="ISO weekday" value={`${result.weekday} (${["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][result.weekday - 1]})`} /></StatGrid> : <p className="text-sm text-danger">Choose a valid calendar date.</p>}<p className="text-xs text-faint">ISO 8601 weeks start Monday; week 1 contains the first Thursday of a year. Calculation uses UTC calendar arithmetic, independent of your local timezone.</p></div></Panel>;
}
