"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Field, Notice, Panel, TextInput } from "@/components/ui";
import { call, hardNavigate, safeNext } from "./api";

/** Centered single-panel frame for the sign-in pages (inside <main>, like every page). */
export function AuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <main className="w-full px-4 py-10 sm:px-6 sm:py-16">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          {intro ? <p className="text-[15px] text-muted">{intro}</p> : null}
        </header>
        {children}
      </div>
    </main>
  );
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent-soft underline underline-offset-2 hover:text-ink">
      {children}
    </Link>
  );
}

type Note = { tone: "good" | "error" | "info"; text: string } | null;

function useSubmit() {
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<Note>(null);
  return { working, setWorking, note, setNote };
}

function Status({ note }: { note: Note }) {
  return (
    <div role="status" aria-live="polite">
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ login */

export function LoginForm({ publicMode, next }: { publicMode: boolean; next?: string }) {
  const [id, setId] = useState("");
  const [password, setPassword] = useState("");
  const { working, setWorking, note, setNote } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setNote(null);
    const reply = await call("POST", "/api/account/login", { id: id.trim(), password });
    if (reply.ok) {
      setNote({ tone: "good", text: "Logged in." });
      hardNavigate(safeNext(next));
      return;
    }
    setWorking(false);
    setNote({ tone: "error", text: reply.message });
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4" aria-label="Log in">
        <Field label={publicMode ? "Username or email" : "Account"}>
          <TextInput autoFocus autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} required />
        </Field>
        <Field label="Password">
          <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Status note={note} />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={working || !id.trim() || !password}>
            {working ? "Logging in…" : "Log in"}
          </Button>
          {publicMode ? (
            <span className="text-sm text-muted">
              <A href="/forgot-password">Forgot your password?</A>
            </span>
          ) : null}
        </div>
        {publicMode ? (
          <p className="border-t border-line pt-4 text-sm text-muted">
            No account yet? <A href="/register">Create one</A>. Did not get the confirmation email? <A href="/verify">Send it again</A>.
          </p>
        ) : null}
      </form>
    </Panel>
  );
}

/* --------------------------------------------------------------------------------------------- register */

export function RegisterForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const { working, setWorking, note, setNote } = useSubmit();
  const mismatch = repeat.length > 0 && repeat !== password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || mismatch) return;
    setWorking(true);
    setNote(null);
    const reply = await call<{ message: string }>("POST", "/api/account/register", { username: username.trim(), email: email.trim(), password });
    setWorking(false);
    if (reply.ok) setDone(reply.body.message);
    else setNote({ tone: "error", text: reply.message });
  }

  if (done) {
    return (
      <Panel>
        <div className="space-y-3" role="status" aria-live="polite">
          <Notice tone="good">{done}</Notice>
          <p className="text-sm text-muted">The link works once and expires in 24 hours. Then <A href="/login">log in</A>.</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4" aria-label="Create account">
        <Field label="Username" hint="Lowercase letters, digits, - and _; up to 32 characters.">
          <TextInput autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required maxLength={32} />
        </Field>
        <Field label="Email" hint="You confirm it before the first login.">
          <TextInput type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <TextInput type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        </Field>
        <Field label="Repeat password">
          <TextInput type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
        {mismatch ? <Notice tone="warn">The passwords do not match.</Notice> : null}
        <Status note={note} />
        <Button type="submit" variant="primary" disabled={working || mismatch || !username || !email || password.length < 10}>
          {working ? "Creating…" : "Create account"}
        </Button>
        <p className="border-t border-line pt-4 text-sm text-muted">
          Already have an account? <A href="/login">Log in</A>.
        </p>
      </form>
    </Panel>
  );
}

/* ----------------------------------------------------------------------------------------------- verify */

/** With a token: one button consumes it (a mail scanner prefetching the link does not). Without: resend the link. */
export function VerifyPanel({ token }: { token: string | null }) {
  const [result, setResult] = useState<Note>(null);
  const [working, setWorking] = useState(false);
  const [verified, setVerified] = useState(false);

  async function confirm() {
    if (!token || working) return;
    setWorking(true);
    const reply = await call<{ kind: "verified" | "email_changed"; username: string }>("POST", "/api/account/verify", { token });
    setWorking(false);
    if (reply.ok) {
      setVerified(true);
      setResult({
        tone: "good",
        text: reply.body.kind === "verified"
          ? `Your email is confirmed, ${reply.body.username}. You can log in now.`
          : "Your new email address is confirmed and in use now.",
      });
    } else {
      setResult({ tone: "error", text: reply.message });
    }
  }

  return (
    <div className="space-y-4">
      {token ? (
        <Panel title="Confirm your email">
          <div className="space-y-3">
            {!verified ? (
              <Button variant="primary" onClick={confirm} disabled={working}>
                {working ? "Confirming…" : "Confirm my email"}
              </Button>
            ) : null}
            <Status note={result} />
            {verified ? <p className="text-sm text-muted"><A href="/login">Log in</A> or go <A href="/account">to your account</A>.</p> : null}
          </div>
        </Panel>
      ) : null}
      <ResendForm />
    </div>
  );
}

export function ResendForm() {
  const [email, setEmail] = useState("");
  const { working, setWorking, note, setNote } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setNote(null);
    const reply = await call<{ message: string }>("POST", "/api/account/resend", { email: email.trim() });
    setWorking(false);
    setNote(reply.ok ? { tone: "good", text: reply.body.message } : { tone: "error", text: reply.message });
  }

  return (
    <Panel title="Send the confirmation link again">
      <form onSubmit={submit} className="space-y-4" aria-label="Resend confirmation">
        <Field label="Email">
          <TextInput type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Status note={note} />
        <Button type="submit" disabled={working || !email.trim()}>
          {working ? "Sending…" : "Send a new link"}
        </Button>
      </form>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------------------- forgot / reset */

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const { working, setWorking, note, setNote } = useSubmit();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setNote(null);
    const reply = await call<{ message: string }>("POST", "/api/account/forgot", { email: email.trim() });
    setWorking(false);
    setNote(reply.ok ? { tone: "good", text: reply.body.message } : { tone: "error", text: reply.message });
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4" aria-label="Reset password">
        <Field label="Email" hint="The link works once and expires in 1 hour.">
          <TextInput autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Status note={note} />
        <Button type="submit" variant="primary" disabled={working || !email.trim()}>
          {working ? "Sending…" : "Send reset link"}
        </Button>
        <p className="border-t border-line pt-4 text-sm text-muted">
          Remembered it? <A href="/login">Log in</A>.
        </p>
      </form>
    </Panel>
  );
}

export function ResetForm({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const { working, setWorking, note, setNote } = useSubmit();
  const mismatch = repeat.length > 0 && repeat !== password;

  if (!token) {
    return (
      <Panel>
        <Notice tone="error">This page needs the link from the reset email. <A href="/forgot-password">Ask for one</A>.</Notice>
      </Panel>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working || mismatch) return;
    setWorking(true);
    setNote(null);
    const reply = await call("POST", "/api/account/reset", { token, password });
    setWorking(false);
    if (reply.ok) {
      setDone(true);
      setNote({ tone: "good", text: "Your password is set. Every device was signed out; log in with the new password." });
    } else {
      setNote({ tone: "error", text: reply.message });
    }
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4" aria-label="Set a new password">
        {!done ? (
          <>
            <Field label="New password" hint="At least 10 characters.">
              <TextInput autoFocus type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
            </Field>
            <Field label="Repeat password">
              <TextInput type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
            </Field>
            {mismatch ? <Notice tone="warn">The passwords do not match.</Notice> : null}
          </>
        ) : null}
        <Status note={note} />
        {done ? (
          <p className="text-sm text-muted"><A href="/login">Log in</A></p>
        ) : (
          <Button type="submit" variant="primary" disabled={working || mismatch || password.length < 10}>
            {working ? "Saving…" : "Set password"}
          </Button>
        )}
      </form>
    </Panel>
  );
}
