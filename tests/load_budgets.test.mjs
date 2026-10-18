// Load budgets for public mode (abuse audit #7, #8, #14): the scratch/data-dir free-space floor (src/lib/storage/disk-floor.ts),
// the global floor in the quota check (src/lib/storage/quota.ts), upload slots (src/lib/upload-budget.ts), the work queue's
// privileged reserve + per-submit owner cap (src/lib/work-queue.ts) and the Python admission policy
// (src/lib/python-admission.ts). Each attack from the audit is replayed as a regression test.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tests/ts-resolve.mjs --test tests/load_budgets.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "knife-budgets-unit-"));
process.env.KNIFE_DATA_DIR = dataDir;
process.env.KNIFE_STORAGE_KEY_FILE = join(dataDir, "storage.key");
process.env.KNIFE_AUTH_MODE = "public";
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const store = await import("../src/lib/accounts/store.ts");
const floor = await import("../src/lib/storage/disk-floor.ts");
const quota = await import("../src/lib/storage/quota.ts");
const budget = await import("../src/lib/upload-budget.ts");
const { WorkQueue, pythonLaneConfig, pythonQueue } = await import("../src/lib/work-queue.ts");
const admission = await import("../src/lib/python-admission.ts");
const { pdfUploadMaxBytes } = await import("../src/lib/jobs.ts");

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
store.mutateStore((s) => {
  s.accounts.push(store.newAccountRecord({ id: "root", displayName: "Root", role: "admin", status: "active" }));
  s.accounts.push(store.newAccountRecord({ id: "old", displayName: "Old", role: "user", status: "active", createdAt: hoursAgo(72), storageQuotaBytes: 100 * GB }));
  s.accounts.push(store.newAccountRecord({ id: "fresh", displayName: "Fresh", role: "user", status: "active", createdAt: hoursAgo(1), storageQuotaBytes: 100 * GB }));
  s.accounts.push(store.newAccountRecord({ id: "tiny", displayName: "Tiny", role: "user", status: "active", createdAt: hoursAgo(72), storageQuotaBytes: 1000 }));
  s.accounts.push(store.newAccountRecord({ id: "unlimited", displayName: "Unlimited", role: "user", status: "active", createdAt: hoursAgo(72), storageQuotaBytes: null }));
});

/** A fake filesystem: `free` bytes of `total`. */
function disk(free, total = 100 * GB) {
  floor.setDiskProbeForTests(() => ({ totalBytes: total, freeBytes: free }));
}
test.afterEach(() => {
  floor.setDiskProbeForTests(null);
  for (const name of ["KNIFE_DISK_FLOOR_GB", "KNIFE_DISK_FLOOR_PERCENT", "KNIFE_UPLOADS_PER_ACCOUNT", "KNIFE_UPLOADS_MAX", "KNIFE_UPLOADS_INFLIGHT_MAX_MB"]) delete process.env[name];
  process.env.KNIFE_AUTH_MODE = "public";
});

// ---- disk floor -------------------------------------------------------------------------------------------------

test("disk floor: max of 10 GB and 10 % by default, both env-overridable, 0 disables a part", () => {
  assert.equal(floor.floorBytes(50 * GB), 10 * GB); // 10 % = 5 GB < 10 GB
  assert.equal(floor.floorBytes(1000 * GB), 100 * GB); // 10 % = 100 GB > 10 GB
  process.env.KNIFE_DISK_FLOOR_GB = "0";
  process.env.KNIFE_DISK_FLOOR_PERCENT = "0";
  assert.equal(floor.floorBytes(1000 * GB), 0);
  process.env.KNIFE_DISK_FLOOR_GB = "2";
  assert.equal(floor.floorBytes(1000 * GB), 2 * GB);
});

test("disk floor: refuses what would cross it, counts admitted bytes inside the cache window, unreadable = full", () => {
  disk(12 * GB);
  assert.equal(floor.admitDiskBytes("/x", 1 * GB), true); // 11 GB left >= 10 GB
  assert.equal(floor.admitDiskBytes("/x", 1 * GB), true); // 10 GB left
  assert.equal(floor.admitDiskBytes("/x", 1), false, "the burst inside one statfs window is counted, not re-read");
  assert.equal(floor.admitDiskBytes("/x", 0), true, "shrinking or deleting always passes");
  floor.setDiskProbeForTests(() => {
    throw new Error("EIO");
  });
  assert.equal(floor.admitDiskBytes("/x", 1), false);
  // The real statfs on this machine answers (smoke: a number).
  floor.setDiskProbeForTests(null);
  assert.equal(typeof floor.freeBytes(tmpdir()), "number");
});

// ---- quota + global floor (#14) -------------------------------------------------------------------------------

test("#14: many accounts each under quota cannot take the data dir under the floor; admins and private mode can", () => {
  disk(10 * GB + 50 * MB);
  // Replay: N accounts with plenty of quota left each write a little; the floor stops them all, whoever writes.
  assert.doesNotThrow(() => quota.assertCanStore("old", 40 * MB));
  assert.throws(() => quota.assertCanStore("fresh", 40 * MB), (error) => error instanceof quota.StorageFullError && error instanceof quota.QuotaExceededError && error.code === "storage_full");
  assert.throws(() => quota.assertCanStore("unlimited", 40 * MB), quota.StorageFullError, "an unlimited quota does not bypass the floor");
  assert.doesNotThrow(() => quota.assertCanStore("root", 5 * GB), "administrators are not refused by the floor");
  process.env.KNIFE_AUTH_MODE = "private";
  assert.doesNotThrow(() => quota.assertCanStore("fresh", 5 * GB), "private mode is unchanged");
});

test("#14: the floor error is generic, carries Retry-After and maps to 507 like a quota error; canStore stays quota-only", () => {
  disk(1 * GB);
  let caught;
  try {
    quota.writeAccountFile("old", join(dataDir, "docs", "old", "x.bin"), new Uint8Array(1024));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof quota.StorageFullError, "writeAccountFile goes through the floor");
  assert.doesNotMatch(caught.message, /\d+\s*(GB|MB|%)/, "no server numbers in the message");
  assert.deepEqual(Object.keys(caught.details()).sort(), ["code", "neededBytes", "retryAfterSec"]);
  // The office save's "drop old versions to make room" loop asks canStore: low disk must not look like a full quota.
  assert.equal(quota.canStore("old", 1024), true);
  assert.equal(quota.canStore("tiny", 2000), false);
  assert.throws(() => quota.assertCanStore("tiny", 2000), (error) => error instanceof quota.QuotaExceededError && error.code === "storage_quota_exceeded");
  // Bookkeeping writes (enforce: false) are never refused.
  assert.doesNotThrow(() => quota.writeAccountFile("old", join(dataDir, "usage", "old.json"), "{}", { enforce: false }));
});

test("new accounts' quota: KNIFE_USER_QUOTA_MB, default 1 GiB (read at startup, stored per account)", () => {
  assert.equal(store.DEFAULT_USER_QUOTA_BYTES, 1024 * MB);
});

// ---- upload budget (#7) ---------------------------------------------------------------------------------------

test("#7: one account opening 40 parallel uploads gets 2 slots; nothing else is reserved", () => {
  disk(500 * GB, 1000 * GB);
  const granted = [];
  const refused = [];
  for (let i = 0; i < 40; i += 1) {
    try {
      granted.push(budget.reserveUpload({ owner: "old", declaredBytes: null, maxBytes: 100 * MB }));
    } catch (error) {
      refused.push(error);
    }
  }
  assert.equal(granted.length, 2);
  assert.ok(refused.every((error) => budget.isUploadBudgetError(error) && error.status === 429 && error.retryAfterSec >= 1));
  assert.equal(budget.uploadBudgetStats().reservedBytes, 200 * MB, "a chunked upload reserves the cap");
  for (const slot of granted) slot.release();
  for (const slot of granted) slot.release(); // idempotent
  assert.deepEqual([budget.uploadBudgetStats().inFlight, budget.uploadBudgetStats().reservedBytes, budget.uploadBudgetStats().accounts], [0, 0, 0]);
});

test("#7: 40 accounts get 5 slots server-wide (one kept for an administrator), bytes are budgeted, admin still uploads", () => {
  disk(500 * GB, 1000 * GB);
  const slots = [];
  let busy = 0;
  for (let i = 0; i < 40; i += 1) {
    try {
      slots.push(budget.reserveUpload({ owner: `u${i}`, declaredBytes: 10 * MB, maxBytes: 100 * MB }));
    } catch (error) {
      assert.equal(error.status, 503);
      busy += 1;
    }
  }
  assert.deepEqual([slots.length, busy], [5, 35]);
  const admin = budget.reserveUpload({ owner: "root", declaredBytes: null, maxBytes: 100 * MB, privileged: true });
  assert.throws(() => budget.reserveUpload({ owner: "root2", declaredBytes: 1, maxBytes: 100 * MB, privileged: true }), (error) => error.status === 503, "6 is the hard cap");
  for (const slot of [...slots, admin]) slot.release();

  // Byte budget: 512 MB in public mode; four 100 MB chunked uploads from different accounts fit, the sixth does not.
  process.env.KNIFE_UPLOADS_MAX = "50";
  const big = [];
  for (let i = 0; i < 5; i += 1) big.push(budget.reserveUpload({ owner: `b${i}`, declaredBytes: null, maxBytes: 100 * MB }));
  assert.throws(() => budget.reserveUpload({ owner: "b5", declaredBytes: null, maxBytes: 100 * MB }), (error) => error.status === 503);
  // shrinkTo hands the unused part back.
  big[0].shrinkTo(1 * MB);
  const after = budget.reserveUpload({ owner: "b5", declaredBytes: 90 * MB, maxBytes: 100 * MB });
  assert.equal(after.bytes, 90 * MB, "a declared length is the reservation (and the body cap)");
  for (const slot of [...big, after]) slot.release();
  assert.equal(budget.uploadBudgetStats().reservedBytes, 0);
});

test("#7: the scratch filesystem's floor refuses an upload before any byte is read", () => {
  disk(10 * GB + 50 * MB);
  assert.throws(() => budget.reserveUpload({ owner: "old", declaredBytes: null, maxBytes: 100 * MB }), (error) => error.status === 503 && error.retryAfterSec === 60);
  assert.equal(budget.uploadBudgetStats().inFlight, 0, "nothing held after a refusal");
  const small = budget.reserveUpload({ owner: "old", declaredBytes: 10 * MB, maxBytes: 100 * MB });
  small.release();
});

test("upload defaults: public 2 / 6 / 512 MB and 100 MB per request; private 8 / 16 / 4096 MB and 512 MB", () => {
  assert.deepEqual(budget.uploadBudgetSettings(), { perAccount: 2, max: 6, inflightBytes: 512 * MB, reserved: 1 });
  assert.equal(pdfUploadMaxBytes(), 100 * MB);
  process.env.KNIFE_AUTH_MODE = "private";
  assert.deepEqual(budget.uploadBudgetSettings(), { perAccount: 8, max: 16, inflightBytes: 4096 * MB, reserved: 0 });
  assert.equal(pdfUploadMaxBytes(), 512 * MB);
  process.env.KNIFE_UPLOADS_PER_ACCOUNT = "3";
  assert.equal(budget.uploadBudgetSettings().perAccount, 3);
});

// ---- work queue: privileged reserve + owner limits (#8) --------------------------------------------------------

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
};

test("#8: ordinary accounts filling the heavy lane never lock out the administrator, whose job starts next", async () => {
  // The audit's heavy lane: 1 running + 16 waiting. Six accounts with 3 jobs each used to block it; now each has 1 and
  // one place is reserved.
  const queue = new WorkQueue({ heavy: { concurrency: 1, maxDepth: 16, perOwner: 3, reserved: 1 } });
  const gate = deferred();
  const order = [];
  const jobs = [];
  let refused = 0;
  for (let account = 0; account < 20; account += 1) {
    for (let n = 0; n < 3; n += 1) {
      try {
        jobs.push(queue.submit("heavy", async () => {
          order.push(`u${account}`);
          await gate.promise;
        }, { owner: `u${account}`, ownerLimit: 1 }));
      } catch (error) {
        assert.equal(error.code, "QUEUE_FULL");
        refused += 1;
      }
    }
  }
  assert.equal(jobs.length, 16, "ordinary jobs take concurrency + depth - reserved places");
  assert.equal(refused, 44);
  const admin = queue.submit("heavy", async () => {
    order.push("admin");
    await gate.promise;
  }, { owner: "root", privileged: true });
  assert.equal(admin.position(), 15, "admitted into the reserved place");
  assert.throws(() => queue.submit("heavy", async () => 1, { owner: "root2", privileged: true }), (error) => error.scope === "lane", "the lane itself is still bounded");
  gate.resolve();
  await Promise.all([...jobs, admin].map((job) => job.promise));
  assert.equal(order[0], "u0");
  assert.equal(order[1], "admin", "a queued privileged job starts before every ordinary one");
});

test("work queue: ownerLimit overrides the lane's perOwner per submit; invalid reserve is a programmer error", () => {
  const queue = new WorkQueue({ lane: { concurrency: 1, maxDepth: 10, perOwner: 5 } });
  queue.submit("lane", () => new Promise(() => {}), { owner: "a", ownerLimit: 1 });
  assert.throws(() => queue.submit("lane", async () => 1, { owner: "a", ownerLimit: 1 }), (error) => error.scope === "owner" && /1 jobs/.test(error.message));
  assert.doesNotThrow(() => queue.submit("lane", () => new Promise(() => {}), { owner: "a" }), "the lane's own cap (5) applies without ownerLimit");
  assert.equal(queue.hasCapacity("lane", "a", { ownerLimit: 2 }), false);
  assert.throws(() => new WorkQueue({ lane: { concurrency: 1, maxDepth: 2, reserved: 3 } }), RangeError);
  assert.throws(() => new WorkQueue({ lane: { concurrency: 1, maxDepth: 2, reserved: -1 } }), RangeError);
});

test("python lanes: public mode reserves places for administrators, private mode is unchanged", () => {
  const pub = pythonLaneConfig({ KNIFE_AUTH_MODE: "public" });
  assert.deepEqual(pub, {
    light: { concurrency: 4, maxDepth: 64, perOwner: 8, reserved: 2 },
    heavy: { concurrency: 1, maxDepth: 16, perOwner: 3, reserved: 1 },
  });
  assert.deepEqual(pythonLaneConfig({}), { light: { concurrency: 4, maxDepth: 64, perOwner: 8 }, heavy: { concurrency: 1, maxDepth: 16, perOwner: 3 } });
  // A reserve can never swallow the whole lane.
  assert.equal(pythonLaneConfig({ KNIFE_AUTH_MODE: "public", KNIFE_PY_HEAVY_DEPTH: "0", KNIFE_PY_HEAVY_RESERVED: "5" }).heavy.reserved, undefined);
  assert.equal(pythonLaneConfig({ KNIFE_AUTH_MODE: "public", KNIFE_PY_LIGHT_RESERVED: "0" }).light.reserved, undefined);
});

// ---- python admission policy (#8) ------------------------------------------------------------------------------

test("#8 policy: admins privileged with no rate; ordinary heavy 1 / light 3; new accounts light 2 and a smaller rate", () => {
  assert.deepEqual(admission.pythonPolicy("heavy", "root"), { privileged: true });
  const old = admission.pythonPolicy("heavy", "old");
  assert.deepEqual([old.privileged, old.ownerLimit, old.rate.max, old.rate.windowMs], [false, 1, 30, 600_000]);
  const oldLight = admission.pythonPolicy("light", "old");
  assert.deepEqual([oldLight.ownerLimit, oldLight.rate.max], [3, 120]);
  const fresh = admission.pythonPolicy("light", "fresh");
  assert.deepEqual([fresh.ownerLimit, fresh.rate.max], [2, 40]);
  assert.equal(admission.pythonPolicy("heavy", "fresh").rate.max, 10);
  assert.equal(admission.pythonPolicy("heavy", "nobody-on-record").rate.max, 10, "no record counts as new");
  assert.equal(admission.isNewAccount(hoursAgo(23.5)), true);
  assert.equal(admission.isNewAccount(hoursAgo(24.5)), false);
  assert.equal(admission.isNewAccount("garbage"), true);
  process.env.KNIFE_AUTH_MODE = "private";
  assert.deepEqual(admission.pythonPolicy("heavy", "old"), {}, "private mode: the lane's own caps, no rate");
  process.env.KNIFE_AUTH_MODE = "public";
  assert.deepEqual(admission.pythonPolicy("heavy", undefined), {}, "ownerless work has no bucket");
});

test("#8 rate: a new account gets 10 heavy jobs per 10 minutes (429 + Retry-After), counted only when admitted", () => {
  const now = Date.now();
  let started = 0;
  const submit = () => {
    started += 1;
    return started;
  };
  for (let i = 0; i < 10; i += 1) admission.admitPythonJob("heavy", "fresh", submit, now + i);
  assert.throws(() => admission.admitPythonJob("heavy", "fresh", submit, now + 20), (error) => error.code === "QUEUE_FULL" && error.scope === "rate" && error.retryAfterSec > 500);
  assert.equal(started, 10, "the refused one never reached the queue");
  assert.throws(() => admission.assertPythonCapacity("heavy", "fresh", now + 30), (error) => error.scope === "rate", "the pre-upload check sees it too");
  // A refused submit (queue full) is not counted.
  assert.throws(() => admission.admitPythonJob("light", "old", () => {
    throw new Error("queue said no");
  }, now));
  for (let i = 0; i < 120; i += 1) admission.admitPythonJob("light", "old", submit, now + i);
  assert.throws(() => admission.admitPythonJob("light", "old", submit, now + 200), (error) => error.scope === "rate");
  // After the window the allowance is back; administrators never have one.
  assert.doesNotThrow(() => admission.admitPythonJob("heavy", "fresh", submit, now + 600_001 + 20));
  for (let i = 0; i < 200; i += 1) admission.admitPythonJob("heavy", "root", submit, now + i);
});

test("#8 end to end on the app queue: the policy's admission reaches the lane (public singleton)", async () => {
  const queue = pythonQueue();
  assert.equal(queue.stats().heavy.reserved, 1, "created in public mode");
  const hold = admission.admitPythonJob("heavy", "u-e2e", (adm) => queue.submit("heavy", ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", resolve)), { owner: "u-e2e", ...adm }), Date.now() - 3 * 600_000);
  assert.equal(hold.state(), "running");
  assert.throws(() => admission.assertPythonCapacity("heavy", "u-e2e"), (error) => error.scope === "owner", "heavy share of an ordinary account is 1");
  hold.cancel();
  await hold.promise.catch(() => {});
});

test("#7: a stalled upload body is abandoned after the idle timeout (408) instead of sitting on its slot", async () => {
  const { receiveMultipart, UploadError } = await import("../src/lib/multipart-upload.ts");
  const dir = mkdtempSync(join(tmpdir(), "knife-budgets-idle-"));
  try {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('--b\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://x/api/pdf", { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=b" } });
    const started = Date.now();
    await assert.rejects(receiveMultipart(request, dir, { maxTotalBytes: MB, maxFileBytes: MB, maxFiles: 1, idleTimeoutMs: 200 }), (error) => error instanceof UploadError && error.status === 408);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(cancelled, true, "the body stream is cancelled");
    assert.equal(budget.uploadIdleTimeoutMs(), 30_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
