"use client";
import { useMemo, useState } from "react";
import { Field, Notice, NumberField, Panel, Stat, StatGrid, TextInput } from "@/components/ui";
export default function SnowflakeDecoder() {
  const [id, setId] = useState("175928847299117063"), [epoch, setEpoch] = useState("1288834974657"), [workerBits, setWorkerBits] = useState(10), [sequenceBits, setSequenceBits] = useState(12);
  const result = useMemo(() => { try {
    if (!/^\d+$/.test(id) || !/^\d+$/.test(epoch) || workerBits < 1 || sequenceBits < 1 || workerBits + sequenceBits >= 63) throw new Error("Use unsigned decimal ID and epoch; bit widths must total under 63.");
    const value = BigInt(id), seqMask = (1n << BigInt(sequenceBits)) - 1n, workerMask = (1n << BigInt(workerBits)) - 1n;
    const sequence = value & seqMask, worker = (value >> BigInt(sequenceBits)) & workerMask;
    const timestamp = value >> BigInt(workerBits + sequenceBits);
    const milliseconds = Number(timestamp + BigInt(epoch));
    if (!Number.isSafeInteger(milliseconds)) throw new Error("Decoded timestamp is outside JavaScript's safe date range.");
    return { timestamp: new Date(milliseconds).toISOString(), worker: String(worker), sequence: String(sequence), error: "" };
  } catch (e) { return { timestamp: "", worker: "", sequence: "", error: e instanceof Error ? e.message : "Invalid ID." }; } }, [epoch, id, sequenceBits, workerBits]);
  return <Panel title="Snowflake ID decoder"><div className="space-y-3"><Field label="64-bit ID"><TextInput value={id} onChange={(e) => setId(e.target.value)} /></Field><Field label="Epoch (Unix milliseconds)"><TextInput value={epoch} onChange={(e) => setEpoch(e.target.value)} /></Field>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Worker bits"><NumberField min={1} max={61} integer value={workerBits} onValueChange={setWorkerBits} /></Field><Field label="Sequence bits"><NumberField min={1} max={61} integer value={sequenceBits} onValueChange={setSequenceBits} /></Field></div>
    {result.error ? <Notice tone="error">{result.error}</Notice> : <StatGrid><Stat label="Timestamp" value={result.timestamp} /><Stat label="Worker" value={result.worker} /><Stat label="Sequence" value={result.sequence} /></StatGrid>}
    <p className="text-xs text-faint">Assumes timestamp bits occupy the high portion, then worker bits, then sequence bits. Configure the epoch and widths for the ID system you are decoding.</p></div></Panel>;
}
