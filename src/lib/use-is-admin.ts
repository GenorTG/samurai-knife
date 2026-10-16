"use client";

import { useEffect, useState } from "react";

/**
 * Whether the signed-in account is an admin (`isAdmin` from GET /api/account; every account in private mode). null until
 * known, so a component renders nothing role-dependent on the server or in the first client render (no hydration diff).
 * One request per page load: signing in or out is a full page load (hardNavigate), so the answer cannot go stale.
 */
let pending: Promise<boolean> | null = null;

function loadIsAdmin(): Promise<boolean> {
  pending ??= fetch("/api/account", { cache: "no-store", credentials: "same-origin" })
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { isAdmin?: unknown } | null;
      return response.ok && body?.isAdmin === true;
    })
    .catch(() => {
      pending = null;
      return false;
    });
  return pending;
}

export function useIsAdmin(): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void loadIsAdmin().then((value) => {
      if (alive) setAdmin(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return admin;
}
