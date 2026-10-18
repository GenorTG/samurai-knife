// Database course result limits (src/lib/learn/sql/limits.ts) and the runner that uses them (db.ts runLearnerSql),
// against a fake Postgres wire server: no docker. Regression for the audit's "one query can crash the app with a huge
// result": a 500 MB value is refused after a few MB on the wire, millions of RETURNING rows are streamed and counted
// (never buffered), long cells are cut with a marker.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/learn_limits.test.mjs
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

const limits = await import("../src/lib/learn/sql/limits.ts");
const { runLearnerSql } = await import("../src/lib/learn/sql/db.ts");
const { WireGuard, RowCollector, ResultBudget, clipCell, clipText, CELL_MAX_CHARS, RESULT_LIMIT_CODE } = limits;

/* ------------------------------------------------------------------------------------------ pure parts */

function message(type, body) {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

test("wire guard: follows message framing across arbitrary chunk splits", () => {
  const stream = Buffer.concat([message("D", Buffer.alloc(1000)), message("C", Buffer.from("SELECT 1\0")), message("Z", Buffer.from("I"))]);
  for (const size of [1, 2, 3, 4, 5, 7, 64, stream.length]) {
    const guard = new WireGuard(1100, 10_000);
    for (let i = 0; i < stream.length; i += size) assert.equal(guard.feed(stream.subarray(i, i + size)), null, `chunk ${size}`);
    assert.equal(guard.received, stream.length);
  }
});

test("wire guard: a message declared larger than the cap trips at its header, before the payload arrives", () => {
  const guard = new WireGuard(1024 * 1024, 1 << 30);
  const header = Buffer.alloc(5);
  header.write("D", 0, "latin1");
  header.writeUInt32BE(500_000_000, 1);
  assert.equal(guard.feed(message("Z", Buffer.from("I"))), null);
  assert.equal(guard.feed(header.subarray(0, 3)), null, "half a header is not judged yet");
  const error = guard.feed(header.subarray(3));
  assert.ok(error instanceof limits.ResultLimitError);
  assert.equal(error.code, RESULT_LIMIT_CODE);
  assert.match(error.message, /larger than 1 MB/);
  assert.equal(guard.feed(Buffer.alloc(10)), error, "stays tripped");
});

test("wire guard: many small messages trip the run total; malformed lengths trip too", () => {
  const guard = new WireGuard(1024, 10_000);
  let error = null;
  for (let i = 0; i < 200 && !error; i += 1) error = guard.feed(message("D", Buffer.alloc(100)));
  assert.ok(error, "tripped");
  assert.match(error.message, /result is larger than/);
  const bad = Buffer.from([0x44, 0, 0, 0, 1]);
  assert.match(new WireGuard().feed(bad).message, /malformed/);
});

test("clipCell / clipText: long text cut with a deterministic marker, other values untouched", () => {
  assert.equal(clipCell("short"), "short");
  assert.equal(clipCell(42), 42);
  assert.equal(clipCell(null), null);
  const cut = clipCell("x".repeat(CELL_MAX_CHARS + 5));
  assert.equal(cut, `${"x".repeat(CELL_MAX_CHARS)}… [truncated: ${CELL_MAX_CHARS + 5} characters]`);
  assert.equal(clipCell("x".repeat(CELL_MAX_CHARS + 5)), cut, "same input, same marker (check comparisons stay stable)");
  assert.equal(clipText(undefined), undefined);
  assert.ok(clipText("e".repeat(5000)).length < 2100);
});

test("row collector: row cap, shared byte budget across result sets, counts everything it drops", () => {
  const budget = new ResultBudget(1000);
  const first = new RowCollector(3, budget, (v) => v);
  for (let i = 0; i < 10; i += 1) first.add([i, "a"]);
  assert.equal(first.rows.length, 3);
  assert.equal(first.seen, 10);
  assert.equal(first.truncated, true);
  const second = new RowCollector(100, budget, (v) => v);
  for (let i = 0; i < 50; i += 1) second.add(["y".repeat(100)]);
  assert.ok(second.rows.length < 10, `budget stops keeping rows (${second.rows.length})`);
  assert.equal(second.seen, 50);
  assert.equal(second.truncated, true);
  const third = new RowCollector(100, budget, (v) => v);
  third.add(["z"]);
  assert.equal(third.rows.length, 0, "a spent budget stays spent for the rest of the run");
  const clip = new RowCollector(5, new ResultBudget(), (v) => v);
  clip.add(["q".repeat(CELL_MAX_CHARS * 3)]);
  assert.equal(clip.clipped, true);
  assert.ok(clip.rows[0][0].length < CELL_MAX_CHARS + 100);
});

/* ------------------------------------------------------------------------------- fake Postgres server */

function cstr(text) {
  return Buffer.from(`${text}\0`);
}

function rowDescription(names) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(names.length);
  for (const name of names) {
    const field = Buffer.alloc(18);
    field.writeUInt32BE(0, 0);
    field.writeUInt16BE(0, 4);
    field.writeUInt32BE(25, 6); // text
    field.writeInt16BE(-1, 10);
    field.writeInt32BE(-1, 12);
    field.writeUInt16BE(0, 16);
    parts.push(cstr(name), field);
  }
  return message("T", Buffer.concat(parts));
}

function dataRow(values) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16BE(values.length);
  for (const value of values) {
    const bytes = Buffer.from(String(value));
    const len = Buffer.alloc(4);
    len.writeInt32BE(bytes.length);
    parts.push(len, bytes);
  }
  return message("D", Buffer.concat(parts));
}

const ready = () => message("Z", Buffer.from("I"));
const complete = (tag) => message("C", cstr(tag));

/**
 * Speaks just enough of the v3 protocol for runLearnerSql: trust auth, simple queries. `answer(sql, socket)` writes the
 * reply for the interesting statements; everything else completes empty.
 */
async function fakePostgres(answer) {
  const stats = { sent: 0, closed: 0 };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let started = false;
    const write = (chunk) => {
      stats.sent += chunk.length;
      return socket.write(chunk);
    };
    socket.on("error", () => {});
    socket.on("close", () => (stats.closed += 1));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return;
          const len = buffer.readUInt32BE(0);
          if (buffer.length < len) return;
          buffer = buffer.subarray(len);
          started = true;
          write(Buffer.concat([message("R", Buffer.from([0, 0, 0, 0])), ready()]));
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]);
        const len = buffer.readUInt32BE(1);
        if (buffer.length < len + 1) return;
        const body = buffer.subarray(5, len + 1);
        buffer = buffer.subarray(len + 1);
        if (type === "X") return socket.end();
        if (type !== "Q") continue;
        const sql = body.subarray(0, body.length - 1).toString();
        if (/pg_backend_pid/.test(sql)) {
          write(Buffer.concat([rowDescription(["pid"]), dataRow([4242]), complete("SELECT 1"), ready()]));
        } else if (!answer(sql, write, socket)) {
          write(Buffer.concat([complete(sql.split(/\s+/)[0].toUpperCase()), ready()]));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const info = { host: "127.0.0.1", port: server.address().port, adminPassword: "x", learnerPassword: "y", key: "fake" };
  return { info, stats, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("runner: a 500 MB value is refused after a few MB on the wire, with a clear error (cursor path)", { timeout: 30_000 }, async () => {
  const pg = await fakePostgres((sql, write, socket) => {
    if (!/^FETCH/.test(sql)) return false;
    write(rowDescription(["big"]));
    const header = Buffer.alloc(11);
    header.write("D", 0, "latin1");
    header.writeUInt32BE(4 + 2 + 4 + 500_000_000, 1);
    header.writeUInt16BE(1, 5);
    header.writeInt32BE(500_000_000, 7);
    write(header);
    const block = Buffer.alloc(1 << 20, 0x78);
    let sent = 0;
    const pump = () => {
      while (!socket.destroyed && sent < 500) {
        sent += 1;
        if (!write(block)) return socket.once("drain", pump);
      }
    };
    pump();
    return true;
  });
  try {
    const heapBefore = process.memoryUsage().arrayBuffers;
    const run = await runLearnerSql(pg.info, "SELECT repeat('x', 500000000)", { timeoutMs: 20_000 });
    assert.equal(run.error?.code, RESULT_LIMIT_CODE, JSON.stringify(run.error));
    assert.match(run.error.message, /larger than 8 MB/);
    assert.equal(run.results.length, 0);
    assert.ok(pg.stats.sent < 64 * 1024 * 1024, `server could send only ${pg.stats.sent} bytes before the app hung up`);
    assert.ok(process.memoryUsage().arrayBuffers - heapBefore < 64 * 1024 * 1024, "nothing close to the value was buffered");
  } finally {
    await pg.close();
  }
});

test("runner: INSERT ... RETURNING over 200 000 rows keeps the row cap, counts all, cuts long cells", async () => {
  const pg = await fakePostgres((sql, write) => {
    if (!/^INSERT/.test(sql)) return false;
    const rows = [rowDescription(["id", "note"])];
    for (let i = 1; i <= 200_000; i += 1) rows.push(dataRow([i, i === 1 ? "n".repeat(50_000) : "ok"]));
    write(Buffer.concat([...rows, complete("INSERT 0 200000"), ready()]));
    return true;
  });
  try {
    const run = await runLearnerSql(pg.info, "INSERT INTO t SELECT g FROM generate_series(1, 200000) g RETURNING *", { rowCap: 500 });
    assert.equal(run.error, null, JSON.stringify(run.error));
    const [result] = run.results;
    assert.equal(result.command, "INSERT");
    assert.equal(result.rows.length, 500);
    assert.equal(result.rowCount, 200_000);
    assert.equal(result.truncated, true);
    assert.equal(result.clipped, true);
    assert.match(result.rows[0][1], /… \[truncated: 50000 characters\]$/);
    assert.equal(result.rows[1][1], "ok");
  } finally {
    await pg.close();
  }
});

test("runner: a huge error message is cut, never passed through whole", async () => {
  const pg = await fakePostgres((sql, write) => {
    if (!/^FETCH/.test(sql)) return false;
    const fields = Buffer.concat([Buffer.from("S"), cstr("ERROR"), Buffer.from("C"), cstr("22P02"), Buffer.from("M"), cstr(`invalid input: ${"x".repeat(1_000_000)}`), Buffer.from([0])]);
    write(Buffer.concat([message("E", fields), ready()]));
    return true;
  });
  try {
    const run = await runLearnerSql(pg.info, "SELECT repeat('x', 1000000)::int");
    assert.equal(run.error?.code, "22P02");
    assert.ok(run.error.message.length < 2100, `message length ${run.error.message.length}`);
  } finally {
    await pg.close();
  }
});
