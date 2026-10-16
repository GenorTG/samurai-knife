"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, Meter, Notice, Panel, TextArea } from "@/components/ui";
import { cx, formatInt } from "@/lib/format";
import { SQL_COURSE } from "@/lib/learn/sql/lessons";
import type { Lesson } from "@/lib/learn/types";
import { ApiError, ensureService, errorText, getOp, isAdminRequired } from "@/tools/sidecars/client";
import { OpProgress, SidecarCard } from "@/tools/sidecars/SidecarCard";
import { useSidecar } from "@/tools/sidecars/useSidecar";
import {
  checkSql,
  getProgress,
  getSchema,
  progressAction,
  runSql,
  setupCourse,
  type CheckResponse,
  type CourseProgress,
  type RunOutput,
  type SchemaTable,
} from "./client";
import { SchemaBrowser } from "./SchemaBrowser";
import { SqlResults } from "./SqlResults";

const COURSE = SQL_COURSE;
const SERVICE = COURSE.sidecar;

const MD_CLASS = cx(
  "space-y-2 text-sm leading-relaxed text-ink",
  "[&_code]:rounded [&_code]:bg-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px]",
  "[&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-field [&_pre]:p-3 [&_pre]:text-[12px]",
  "[&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_strong]:font-semibold [&_em]:italic",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
);

/** Lesson text is the repo's own markdown; still sanitised, like every rendered markdown in the app. */
function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string, { USE_PROFILES: { html: true } }), [text]);
  return <div className={cx(MD_CLASS, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function isDbLost(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "not_running" || error.code === "not_installed");
}

/* ----------------------------------------------------------------------------------------------- workspace */

type Busy = null | "run" | "check" | "hint" | "solution" | "reset";

interface CheckView {
  pass: boolean;
  message: string;
  compare: CheckResponse["compare"];
}

function firstLesson(progress: CourseProgress): string {
  const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("lesson");
  if (fromUrl && COURSE.lessons.some((l) => l.id === fromUrl)) return fromUrl;
  if (progress.current && COURSE.lessons.some((l) => l.id === progress.current)) return progress.current;
  return (COURSE.lessons.find((l) => !progress.lessons[l.id]?.completedAt) ?? COURSE.lessons[0]).id;
}

function LessonList({ progress, current, onSelect }: { progress: CourseProgress; current: string; onSelect: (id: string) => void }) {
  const done = COURSE.lessons.filter((l) => progress.lessons[l.id]?.completedAt).length;
  return (
    <nav aria-label="Lessons" className="space-y-4" data-agent-region="learn-lessons">
      <div className="space-y-1.5">
        <p className="text-sm text-ink">
          {formatInt(done)} of {formatInt(COURSE.lessons.length)} lessons done
        </p>
        <Meter value={(100 * done) / COURSE.lessons.length} label="Course progress" tone="good" />
      </div>
      {COURSE.modules.map((group) => {
        const lessons = COURSE.lessons.filter((l) => l.module === group.id);
        const moduleDone = lessons.filter((l) => progress.lessons[l.id]?.completedAt).length;
        return (
          <section key={group.id} aria-label={group.title} className="space-y-1">
            <h3 className="flex items-baseline justify-between gap-2 text-xs font-semibold text-muted">
              <span>{group.title}</span>
              <span className="font-normal text-faint">
                {moduleDone}/{lessons.length}
              </span>
            </h3>
            <ol className="space-y-0.5">
              {lessons.map((lesson) => {
                const entry = progress.lessons[lesson.id];
                const selected = lesson.id === current;
                return (
                  <li key={lesson.id}>
                    <button
                      type="button"
                      autoComplete="off"
                      aria-current={selected ? "step" : undefined}
                      onClick={() => onSelect(lesson.id)}
                      className={cx(
                        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[13px]",
                        selected ? "bg-accent/15 text-ink" : "text-muted hover:bg-raised hover:text-ink",
                      )}
                    >
                      <span aria-hidden className={cx("w-3 shrink-0 text-center", entry?.completedAt ? "text-good" : "text-faint")}>
                        {entry?.completedAt ? "✓" : entry?.attempts ? "•" : ""}
                      </span>
                      <span className="min-w-0 flex-1">{lesson.title}</span>
                      {entry?.completedAt ? <span className="sr-only">(done)</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </nav>
  );
}

function CheckFeedback({ check, onNext }: { check: CheckView; onNext: (() => void) | null }) {
  const compare = check.compare;
  return (
    <div className="space-y-2" data-agent-region="learn-check">
      <Notice tone={check.pass ? "good" : "warn"}>
        {check.pass ? "Correct! " : "Not yet. "}
        {check.message.replace(/^Correct: /, "")}
      </Notice>
      {!check.pass && compare && (compare.examples.missing.length > 0 || compare.examples.extra.length > 0) ? (
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          {compare.examples.missing.length ? (
            <div>
              <p className="font-semibold text-muted">Expected but missing (examples)</p>
              <ul className="font-mono text-ink">{compare.examples.missing.map((row, i) => <li key={i}>{row}</li>)}</ul>
            </div>
          ) : null}
          {compare.examples.extra.length ? (
            <div>
              <p className="font-semibold text-muted">In your result but not expected (examples)</p>
              <ul className="font-mono text-ink">{compare.examples.extra.map((row, i) => <li key={i}>{row}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {check.pass && onNext ? (
        <Button variant="primary" onClick={onNext}>
          Next lesson →
        </Button>
      ) : null}
    </div>
  );
}

function LessonPane({
  lesson,
  progress,
  onProgress,
  onDbLost,
  onNext,
  insertRef,
}: {
  lesson: Lesson;
  progress: CourseProgress;
  onProgress: (next: CourseProgress) => void;
  onDbLost: () => void;
  onNext: (() => void) | null;
  insertRef: React.RefObject<((text: string) => void) | null>;
}) {
  const entry = progress.lessons[lesson.id];
  const [sql, setSql] = useState(entry?.lastQuery ?? lesson.starter);
  const [busy, setBusy] = useState<Busy>(null);
  const [run, setRun] = useState<{ output: RunOutput; sql: string } | null>(null);
  const [check, setCheck] = useState<CheckView | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(entry?.lastQuery ?? lesson.starter);

  // Remember an edited query when leaving the lesson (the server keeps the last query per lesson).
  const latest = useRef(sql);
  useEffect(() => {
    latest.current = sql;
  }, [sql]);
  useEffect(() => {
    const id = lesson.id;
    return () => {
      if (latest.current !== saved.current) void progressAction(COURSE.id, { action: "save", lessonId: id, sql: latest.current }).catch(() => {});
    };
  }, [lesson.id]);

  useEffect(() => {
    insertRef.current = (text: string) => {
      const area = editor.current;
      if (!area) return;
      const start = area.selectionStart ?? sql.length;
      const end = area.selectionEnd ?? sql.length;
      const next = sql.slice(0, start) + text + sql.slice(end);
      setSql(next);
      requestAnimationFrame(() => {
        area.focus();
        area.setSelectionRange(start + text.length, start + text.length);
      });
    };
    return () => {
      insertRef.current = null;
    };
  }, [insertRef, sql]);

  const fail = useCallback((err: unknown) => {
    if (isDbLost(err)) onDbLost();
    setError(errorText(err));
    setStatus("");
  }, [onDbLost]);

  const doRun = async () => {
    if (busy) return;
    setBusy("run");
    setError(null);
    setCheck(null);
    setStatus("Running the query…");
    try {
      const answer = await runSql(sql, lesson.id);
      saved.current = sql;
      setRun({ output: answer.run, sql });
      if (answer.progress) onProgress(answer.progress);
      setStatus(answer.run.error ? `Query failed after ${formatInt(answer.run.durationMs)} ms.` : `Ran in ${formatInt(answer.run.durationMs)} ms (rolled back).`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const doCheck = async () => {
    if (busy) return;
    setBusy("check");
    setError(null);
    setStatus("Checking your answer…");
    try {
      const answer = await checkSql(sql, lesson.id);
      saved.current = sql;
      setRun({ output: answer.run, sql });
      setCheck({ pass: answer.pass, message: answer.message, compare: answer.compare });
      onProgress(answer.progress);
      setStatus(answer.pass ? "Check passed." : "Check failed.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const doProgress = async (kind: "hint" | "solution" | "reset") => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "reset") {
        setSql(lesson.starter);
        saved.current = lesson.starter;
        setRun(null);
        setCheck(null);
        onProgress(await progressAction(COURSE.id, { action: "reset-query", lessonId: lesson.id }));
        setStatus("Query reset to the starter.");
      } else {
        onProgress(await progressAction(COURSE.id, { action: kind, lessonId: lesson.id }));
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) void doCheck();
      else void doRun();
    }
  };

  const hintsShown = entry?.hintsShown ?? 0;
  const solutionUnlocked = (entry?.failedChecks ?? 0) > 0 || hintsShown >= lesson.hints.length;
  const lessonModule = COURSE.modules.find((m) => m.id === lesson.module);

  return (
    <div className="space-y-4">
      <Panel
        title={lesson.title}
        right={
          <span className="flex items-center gap-2">
            <span className="text-xs text-faint">{lessonModule?.title}</span>
            {entry?.completedAt ? <Badge tone="good">Done</Badge> : null}
          </span>
        }
      >
        <div className="space-y-4" data-agent-region="learn-lesson">
          <Markdown text={lesson.explanation} />
          <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
            <p className="mb-1 text-xs font-semibold tracking-wide text-accent-soft uppercase">Your task</p>
            <Markdown text={lesson.task} />
          </div>
        </div>
      </Panel>

      <Panel title="SQL" right={<span className="text-xs text-faint">Ctrl+Enter runs, Ctrl+Shift+Enter checks</span>}>
        <div className="space-y-3">
          <TextArea
            ref={editor}
            aria-label="SQL editor"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
            rows={Math.min(18, Math.max(6, sql.split("\n").length + 1))}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="SELECT …"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy !== null} onClick={() => void doRun()}>
              Run
            </Button>
            <Button disabled={busy !== null} onClick={() => void doCheck()}>
              Check
            </Button>
            <Button variant="ghost" disabled={busy !== null || hintsShown >= lesson.hints.length} onClick={() => void doProgress("hint")}>
              {hintsShown >= lesson.hints.length ? "No more hints" : `Hint (${hintsShown + 1} of ${lesson.hints.length})`}
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null || !solutionUnlocked || entry?.solutionShown}
              title={solutionUnlocked ? undefined : "Unlocks after a failed check or all hints"}
              onClick={() => void doProgress("solution")}
            >
              Show solution
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => void doProgress("reset")}>
              Reset query
            </Button>
          </div>
          <p role="status" aria-live="polite" className="min-h-5 text-xs text-muted" data-agent-region="learn-status">
            {status}
          </p>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {hintsShown > 0 ? (
            <ol className="space-y-1.5" aria-label="Hints">
              {lesson.hints.slice(0, hintsShown).map((hint, i) => (
                <li key={i} className="rounded-lg border border-line bg-raised/40 px-3 py-2 text-sm">
                  <span className="mr-1 text-xs font-semibold text-muted">Hint {i + 1}:</span>
                  <Markdown text={hint} className="inline [&_p]:inline" />
                </li>
              ))}
            </ol>
          ) : null}
          {entry?.solutionShown ? (
            <div className="space-y-1.5" data-agent-region="learn-solution">
              <p className="text-xs font-semibold text-muted">Reference solution</p>
              <pre className="overflow-auto rounded-lg border border-line bg-field p-3 font-mono text-xs text-ink">{lesson.solution}</pre>
              <Button size="sm" onClick={() => setSql(lesson.solution)}>
                Copy into the editor
              </Button>
            </div>
          ) : null}
          {check ? <CheckFeedback check={check} onNext={onNext} /> : null}
        </div>
      </Panel>

      {run ? (
        <Panel title="Result">
          <SqlResults run={run.output} sql={run.sql} />
        </Panel>
      ) : null}
    </div>
  );
}

function Workspace({ onDbLost }: { onDbLost: () => void }) {
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  const [schema, setSchema] = useState<SchemaTable[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const insertRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getProgress(COURSE.id);
        if (cancelled) return;
        setProgress(loaded);
        setCurrent(firstLesson(loaded));
      } catch (err) {
        if (!cancelled) setError(errorText(err));
      }
      try {
        const tables = await getSchema();
        if (!cancelled) setSchema(tables);
      } catch (err) {
        if (isDbLost(err)) onDbLost();
        else if (!cancelled) setError(errorText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onDbLost]);

  const select = useCallback((id: string) => {
    setCurrent(id);
    const url = new URL(window.location.href);
    url.searchParams.set("lesson", id);
    window.history.replaceState(window.history.state, "", url);
    void progressAction(COURSE.id, { action: "select", lessonId: id }).then(setProgress).catch(() => {});
  }, []);

  if (error && !progress) return <Notice tone="error">{error}</Notice>;
  if (!progress || !current) {
    return (
      <p role="status" className="py-6 text-sm text-muted">
        Loading your progress…
      </p>
    );
  }
  const lesson = COURSE.lessons.find((l) => l.id === current) ?? COURSE.lessons[0];
  const index = COURSE.lessons.indexOf(lesson);
  const next = COURSE.lessons[index + 1];

  return (
    <div className="grid gap-5 lg:grid-cols-[15rem_minmax(0,1fr)] 2xl:grid-cols-[15rem_minmax(0,1fr)_18rem]">
      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-auto lg:pr-1">
        <LessonList progress={progress} current={lesson.id} onSelect={select} />
        <div className="space-y-2 border-t border-line pt-3">
          {confirmReset ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">Forget every completed lesson, hint and saved query of this course?</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => {
                    setConfirmReset(false);
                    try {
                      const fresh = await progressAction(COURSE.id, { action: "reset-course" });
                      setProgress(fresh);
                      select(COURSE.lessons[0].id);
                    } catch (err) {
                      setError(errorText(err));
                    }
                  }}
                >
                  Reset progress
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
              Reset progress…
            </Button>
          )}
        </div>
      </aside>
      <div className="min-w-0 space-y-4">
        {error ? <Notice tone="error">{error}</Notice> : null}
        <LessonPane
          key={lesson.id}
          lesson={lesson}
          progress={progress}
          onProgress={setProgress}
          onDbLost={onDbLost}
          onNext={next ? () => select(next.id) : null}
          insertRef={insertRef}
        />
      </div>
      <aside className="min-w-0 lg:col-span-2 2xl:col-span-1">
        <Panel title="Tables">
          {schema ? (
            <div className="space-y-3">
              <SchemaBrowser tables={schema} onInsert={(text) => insertRef.current?.(text)} />
              <p className="text-xs text-faint">Click a column name to insert it at the cursor.</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={rebuilding}
                onClick={async () => {
                  setRebuilding(true);
                  try {
                    await setupCourse(true);
                    setSchema(await getSchema());
                  } catch (err) {
                    setError(errorText(err));
                  } finally {
                    setRebuilding(false);
                  }
                }}
              >
                {rebuilding ? "Rebuilding the course data…" : "Rebuild course data"}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-muted">
              Loading tables…
            </p>
          )}
        </Panel>
      </aside>
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- page */

type Stage = { kind: "waiting" } | { kind: "starting" } | { kind: "seeding" } | { kind: "ready" } | { kind: "failed"; message: string; needsAdmin?: boolean };

/**
 * SQL & PostGIS course. Needs the `learn-db` sidecar: install card while it is missing; when installed, a lazy start
 * (`ensure`) and the course data check (`setup`) run before the lessons show. docs/LEARN.md.
 */
export default function SqlCourse() {
  const sidecar = useSidecar(SERVICE);
  const { follow, op, refresh } = sidecar;
  const installed = Boolean(sidecar.service?.installed);
  const [stage, setStage] = useState<Stage>({ kind: "waiting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    (async () => {
      setStage({ kind: "starting" });
      try {
        const deadline = Date.now() + 4 * 60_000;
        for (;;) {
          const answer = await ensureService(SERVICE);
          if (answer.ready) break;
          if (answer.op) {
            follow(answer.op);
            let currentOp = answer.op;
            while (currentOp.status === "running" && !cancelled) {
              await new Promise((r) => setTimeout(r, 1000));
              currentOp = await getOp(currentOp.opId);
              follow(currentOp);
            }
            if (currentOp.status === "failed") throw new Error(currentOp.error ?? "the course database did not start");
          }
          if (cancelled) return;
          if (Date.now() > deadline) throw new Error("the course database did not become ready in time");
        }
        if (cancelled) return;
        setStage({ kind: "seeding" });
        await setupCourse();
        if (cancelled) return;
        setStage({ kind: "ready" });
        void refresh();
      } catch (err) {
        if (!cancelled) setStage({ kind: "failed", message: errorText(err), needsAdmin: isAdminRequired(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installed, attempt, follow, refresh]);

  const dbLost = useCallback(() => {
    setStage({ kind: "waiting" });
    setAttempt((n) => n + 1);
  }, []);

  const service = sidecar.service;
  if (!service || !service.installed || !service.runtime.ok) {
    return (
      <div className="space-y-4">
        <SidecarCard
          sidecar={sidecar}
          compact
          intro={
            <Notice tone="info">
              The course runs your queries against a real PostgreSQL + PostGIS database on this machine. Install it once (about
              600 MB download); it starts by itself when you open the course and stops when idle. Nothing you run is kept.
            </Notice>
          }
        />
        <Panel title="What you will learn">
          <ul className="grid gap-1.5 text-sm text-muted sm:grid-cols-2">
            {COURSE.modules.map((group) => (
              <li key={group.id}>
                <span className="text-ink">{group.title}</span> — {group.summary}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    );
  }

  if (stage.kind !== "ready") {
    return (
      <Panel title="Course database">
        <div className="space-y-3">
          {stage.kind === "failed" ? (
            <>
              {stage.needsAdmin ? (
                <Notice tone="info">{stage.message} The course opens once the database is running.</Notice>
              ) : (
                <Notice tone="error">Could not get the course database ready: {stage.message}</Notice>
              )}
              <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </>
          ) : (
            <p role="status" aria-live="polite" className="text-sm text-muted" data-agent-region="learn-db-status">
              {stage.kind === "seeding" ? "Preparing the course data (first time: a few seconds)…" : "Starting the course database…"}
            </p>
          )}
          {stage.kind === "starting" ? <OpProgress op={op} /> : null}
        </div>
      </Panel>
    );
  }

  return <Workspace onDbLost={dbLost} />;
}
