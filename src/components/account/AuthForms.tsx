"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Field, Notice, Panel, TextInput } from "@/components/ui";
import { call, hardNavigate, safeNext } from "./api";
import { CHECKING_TEXT, withChallenge } from "./challenge";
import { GithubButton } from "./GithubButton";

/** Centered single-panel frame for the sign-in pages (inside <main>, like every page). */
export function AuthFrame({ title, intro, aside, children }: { title: string; intro?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  const form = (
    <div className="mx-auto w-full max-w-md space-y-4 lg:mx-0">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {intro ? <p className="text-[15px] text-muted">{intro}</p> : null}
      </header>
      {children}
    </div>
  );
  return (
    <main className="w-full px-4 py-10 sm:px-6 sm:py-16">
      {aside ? (
        <div className="mx-auto grid w-full max-w-5xl items-start gap-10 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-14">
          {form}
          <aside className="mx-auto w-full max-w-md lg:mx-0 lg:max-w-none lg:pt-16">{aside}</aside>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-md">{form}</div>
      )}
    </main>
  );
}

const PERKS: [string, string][] = [
  ["CV studio", "a bilingual CV, a tailored version per job offer, ATS checks and an application tracker"],
  ["Office library", "Word, Excel and PowerPoint files with folders and versions, edited in the browser"],
  ["Website studio and database course", "audit your site from its GitHub repo; learn SQL and PostGIS on a real database"],
  ["AI assistant", "drives the tools with you on the model you choose; connect your own agents over MCP"],
  ["Private storage", "1 GB per account, encrypted at rest, visible to you only"],
];

/** Register page side panel: what an account adds to the browser tools. */
export function AccountPerks() {
  return (
    <div className="rounded-tool border border-line bg-surface/60 p-6">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-accent-soft">Free account</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">Everything in Smart Knife, kept for you</h2>
      <ul className="mt-5 space-y-3.5">
        {PERKS.map(([title, text]) => (
          <li key={title} className="flex gap-3 text-sm">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0 text-accent-soft">
              <path d="M3.5 8.5l3 3 6-7" />
            </svg>
            <span className="text-muted">
              <span className="font-medium text-ink">{title}</span>: {text}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-6 border-t border-line pt-4 text-xs text-faint">
        No card and no trial clock. The browser tools also work without an account: <A href="/">look around first</A>.
      </p>
    </div>
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
    // Private mode never asks for a challenge; public mode only after failed logins (the server answers 428).
    const reply = await withChallenge("login", (pow) => call("POST", "/api/account/login", { id: id.trim(), password, ...(pow ? { pow } : {}) }), {
      upfront: false,
      onChecking: () => setNote({ tone: "info", text: CHECKING_TEXT }),
    });
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

/**
 * Sign-up: one consent (Terms of Service + privacy notice, in the version the page shows) gates both ways in, GitHub and
 * the password form. The server refuses a sign-up without it (400 terms_required) or for another version (409).
 */
export function RegisterChoices({ terms, github }: { terms: string; github: boolean }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <div className="space-y-4">
      <Panel>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--c-accent)]" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} required />
          <span>
            I have read and accept the <A href="/terms">Terms of Service</A> and have read the <A href="/privacy">privacy notice</A> (what is
            stored, where, and your rights). Akceptuję <A href="/terms?lang=pl">Regulamin</A> i zapoznałem/am się z{" "}
            <A href="/privacy?lang=pl">Polityką prywatności</A>.
          </span>
        </label>
      </Panel>
      {github ? (
        <div className="space-y-3">
          <GithubButton label="Sign up with GitHub" purpose="register" terms={terms} disabled={!accepted} />
          <p className="text-center text-xs text-faint">GitHub&apos;s verified email is used; no password needed. Or create an account with a password:</p>
        </div>
      ) : null}
      <RegisterForm terms={terms} accepted={accepted} />
    </div>
  );
}

export function RegisterForm({ terms, accepted }: { terms: string; accepted: boolean }) {
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const { working, setWorking, note, setNote } = useSubmit();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || !accepted) return;
    // Password managers can fill without input/change events. Read the actual form, not cached React state.
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim().toLowerCase();
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const repeat = String(data.get("repeatPassword") ?? "");
    if (password !== repeat) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setWorking(true);
    setNote(null);
    const reply = await withChallenge("register", (pow) => call<{ message: string }>("POST", "/api/account/register", { username: username.trim(), email: email.trim(), password, acceptTerms: terms, pow }), {
      upfront: true,
      onChecking: () => setNote({ tone: "info", text: CHECKING_TEXT }),
    });
    setNote(null);
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
      <form onSubmit={submit} onInput={() => setMismatch(false)} className="space-y-4" aria-label="Create account">
        <Field label="Username" hint="Lowercase letters, digits, - and _; up to 32 characters.">
          <TextInput autoFocus name="username" autoComplete="username" required maxLength={32} />
        </Field>
        <Field label="Email" hint="You confirm it before the first login.">
          <TextInput name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <TextInput name="password" type="password" autoComplete="new-password" required minLength={10} />
        </Field>
        <Field label="Repeat password">
          <TextInput name="repeatPassword" type="password" autoComplete="new-password" required />
        </Field>
        {mismatch ? <Notice tone="warn">The passwords do not match.</Notice> : null}
        <Status note={note} />
        <Button type="submit" variant="primary" disabled={working || !accepted}>
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
    const reply = await withChallenge("resend", (pow) => call<{ message: string }>("POST", "/api/account/resend", { email: email.trim(), pow }), {
      upfront: true,
      onChecking: () => setNote({ tone: "info", text: CHECKING_TEXT }),
    });
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
    const reply = await withChallenge("forgot", (pow) => call<{ message: string }>("POST", "/api/account/forgot", { email: email.trim(), pow }), {
      upfront: true,
      onChecking: () => setNote({ tone: "info", text: CHECKING_TEXT }),
    });
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
    const reply = await withChallenge("reset", (pow) => call<{ mcpKeysRevoked: number }>("POST", "/api/account/reset", { token, password, pow }), {
      upfront: true,
      onChecking: () => setNote({ tone: "info", text: CHECKING_TEXT }),
    });
    setWorking(false);
    if (reply.ok) {
      setDone(true);
      const keys = reply.body.mcpKeysRevoked > 0 ? ` Your ${reply.body.mcpKeysRevoked} MCP key(s) were revoked too.` : "";
      setNote({ tone: "good", text: `Your password is set. Every device was signed out; log in with the new password.${keys}` });
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
