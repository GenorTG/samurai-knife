import { msgf } from "@/lib/i18n/msg";
import net from "node:net";
import type { Cell } from "./compare";

/**
 * Result limits for learner runs: how much a run may send back to the app, bounded by construction.
 *
 * Threat: node-postgres buffers every row of a plain query, and every protocol message whole, before the caller sees
 * it. One learner query returning a huge value (`SELECT repeat('x', 500000000)`) or millions of rows
 * (`INSERT ... SELECT generate_series(1, 2e7) ... RETURNING *`) would grow the app's heap until it crashes, for
 * everyone. Two layers, both per run (= per connection, the runner opens one per run):
 *  - `WireGuard` reads the raw socket before node-postgres does: a backend message over `MAX_MESSAGE_BYTES`, or more
 *    than `RUN_WIRE_BYTES` received in total, destroys the connection (the server rolls the run back) and the run
 *    fails with `ResultLimitError`.
 *  - `RowCollector` takes rows one at a time (a streaming query, never an accumulated result): it keeps at most
 *    `rowCap` rows and `RESULT_BYTES` of cell text per run, cuts each cell at `CELL_MAX_CHARS` with a visible marker,
 *    and only counts the rest.
 */

/** One backend message (a row, an error, a notice) may be at most this large on the wire. */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** Everything one run may receive from the server. */
export const RUN_WIRE_BYTES = 64 * 1024 * 1024;
/** Cell text kept across all result sets of one run. */
export const RESULT_BYTES = 4 * 1024 * 1024;
/** A longer cell is cut here and marked. */
export const CELL_MAX_CHARS = 10_000;
/** Server texts shown to the learner (error message, detail, hint, notice). */
export const TEXT_MAX_CHARS = 2_000;

export const RESULT_LIMIT_CODE = "knife_result_limit";

export class ResultLimitError extends Error {
  readonly code = RESULT_LIMIT_CODE;
}

/** The marker a cut cell ends with (deterministic, so the learner's and the reference result compare alike). */
export function clipCell(cell: Cell, max = CELL_MAX_CHARS): Cell {
  if (typeof cell !== "string" || cell.length <= max) return cell;
  return `${cell.slice(0, max)}… [truncated: ${cell.length} characters]`;
}

export function clipText<T extends string | undefined>(text: T, max = TEXT_MAX_CHARS): T {
  if (typeof text !== "string" || text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated]` as T;
}

function cellBytes(cell: Cell): number {
  return typeof cell === "string" ? Buffer.byteLength(cell) : 8;
}

const HEADER = 5;

/**
 * Follows the backend message framing (1 type byte + int32 length that counts itself) across socket chunks without
 * keeping any payload. `feed` returns the reason once a limit is passed; after that the guard stays tripped.
 */
export class WireGuard {
  private readonly maxMessage: number;
  private readonly maxTotal: number;
  private header = Buffer.alloc(HEADER);
  private headerFill = 0;
  /** Payload bytes of the current message still to skip. */
  private remaining = 0;
  private total = 0;
  tripped: ResultLimitError | null = null;

  constructor(maxMessage = MAX_MESSAGE_BYTES, maxTotal = RUN_WIRE_BYTES) {
    this.maxMessage = maxMessage;
    this.maxTotal = maxTotal;
  }

  get received(): number {
    return this.total;
  }

  feed(chunk: Buffer): ResultLimitError | null {
    if (this.tripped) return this.tripped;
    this.total += chunk.length;
    if (this.total > this.maxTotal) {
      return this.trip(msgf("The result is larger than {value}, so the run was stopped. Return fewer rows (WHERE, LIMIT) or shorter values (left(column, 100)).", { value: mb(this.maxTotal) }));
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining > 0) {
        const skip = Math.min(this.remaining, chunk.length - offset);
        this.remaining -= skip;
        offset += skip;
        continue;
      }
      const take = Math.min(HEADER - this.headerFill, chunk.length - offset);
      chunk.copy(this.header, this.headerFill, offset, offset + take);
      this.headerFill += take;
      offset += take;
      if (this.headerFill < HEADER) break;
      this.headerFill = 0;
      const length = this.header.readUInt32BE(1);
      if (length < 4) return this.trip("The database sent a malformed message, so the run was stopped.");
      if (length + 1 > this.maxMessage) {
        return this.trip(msgf("One row or message of the result is larger than {value}, so the run was stopped. Select shorter values, e.g. left(column, 100) or length(column).", { value: mb(this.maxMessage) }));
      }
      this.remaining = length - 4;
    }
    return null;
  }

  private trip(message: string): ResultLimitError {
    this.tripped = new ResultLimitError(message);
    return this.tripped;
  }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * A plain TCP socket for node-postgres (`stream` option) whose incoming bytes pass the guard first: the guard's
 * listener is registered before node-postgres attaches its parser, so a message that is too large is refused before
 * the parser ever has to hold it (it only sees the current chunk, at most one socket read).
 */
export function guardedSocket(guard: WireGuard): net.Socket {
  const socket = new net.Socket();
  socket.on("data", (chunk: Buffer) => {
    const error = guard.feed(chunk);
    if (error && !socket.destroyed) socket.destroy(error);
  });
  return socket;
}

/** Shared by every result set of one run. */
export class ResultBudget {
  private left: number;
  constructor(bytes = RESULT_BYTES) {
    this.left = bytes;
  }
  /** Takes the bytes if they fit; false = the budget is spent. */
  take(bytes: number): boolean {
    if (bytes > this.left) {
      this.left = 0;
      return false;
    }
    this.left -= bytes;
    return true;
  }
}

/** Collects one result set from a streaming query. */
export class RowCollector {
  readonly rows: Cell[][] = [];
  /** Rows the server sent (kept or not). */
  seen = 0;
  /** More rows than `rowCap`, or rows dropped because the run's result budget was spent. */
  truncated = false;
  /** At least one cell was cut. */
  clipped = false;
  private readonly rowCap: number;
  private readonly budget: ResultBudget;
  private readonly toCell: (value: unknown) => Cell;
  private full = false;

  constructor(rowCap: number, budget: ResultBudget, toCell: (value: unknown) => Cell) {
    this.rowCap = rowCap;
    this.budget = budget;
    this.toCell = toCell;
  }

  add(row: unknown[]): void {
    this.seen += 1;
    if (this.full || this.rows.length >= this.rowCap) {
      this.truncated = true;
      return;
    }
    let bytes = 0;
    const cells = row.map((value) => {
      const raw = this.toCell(value);
      const cell = clipCell(raw);
      if (cell !== raw) this.clipped = true;
      bytes += cellBytes(cell);
      return cell;
    });
    if (!this.budget.take(bytes)) {
      this.full = true;
      this.truncated = true;
      return;
    }
    this.rows.push(cells);
  }
}
