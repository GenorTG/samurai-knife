"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Notice, Select, TextInput } from "@/components/ui";
import type { AccountChoice } from "@/lib/agent-client/types";

export function LoginView({
  accounts,
  onLogin,
}: {
  accounts: AccountChoice[];
  onLogin: (id: string, password: string) => Promise<string | null>;
}) {
  const [id, setId] = useState(accounts[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!id || working) return;
    setWorking(true);
    setError(null);
    const problem = await onLogin(id, password);
    setWorking(false);
    if (problem) setError(problem);
    else setPassword("");
  }

  // Public mode never lists accounts (no user enumeration): the user types a username or email instead.
  if (accounts.length === 0) {
    return (
      <form onSubmit={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="Log in">
        <p className="text-sm text-muted">Log in to use the assistant.</p>
        <Field label="Username or email">
          <TextInput data-agent-autofocus autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} />
        </Field>
        <Field label="Password">
          <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button type="submit" variant="primary" disabled={working || !id.trim()}>
          {working ? "Logging in…" : "Log in"}
        </Button>
        <p className="text-xs text-faint">
          <Link className="underline underline-offset-2" href="/register">Create an account</Link>
          {" · "}
          <Link className="underline underline-offset-2" href="/forgot-password">Forgot your password?</Link>
        </p>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="Log in">
      <p className="text-sm text-muted">Choose an account to use the assistant.</p>
      <Field label="Account">
        <Select data-agent-autofocus value={id} onChange={(e) => setId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Password">
        <TextInput
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" variant="primary" disabled={working || !id}>
        {working ? "Logging in…" : "Log in"}
      </Button>
    </form>
  );
}
