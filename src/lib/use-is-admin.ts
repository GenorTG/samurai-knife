"use client";

import { useEffect, useState } from "react";
import { loadAccount } from "./client-account";

/**
 * Whether the signed-in account is an admin (`isAdmin` from GET /api/account; every account in private mode). null until
 * known, so a component renders nothing role-dependent on the server or in the first client render (no hydration diff).
 */
export function useIsAdmin(): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void loadAccount().then((account) => {
      if (alive) setAdmin(account?.isAdmin === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return admin;
}
