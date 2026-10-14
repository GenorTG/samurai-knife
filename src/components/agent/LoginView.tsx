"use client";

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

  return (
    <form onSubmit={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-label="Log in">
      <p className="text-sm text-muted">Choose an account to use the assistant.</p>
      {accounts.length === 0 ? <Notice tone="error">No accounts exist yet. Create one with the account CLI.</Notice> : null}
      <Field label="Account">
        <Select data-agent-autofocus value={id} onChange={(e) => setId(e.target.value)} disabled={accounts.length === 0}>
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
