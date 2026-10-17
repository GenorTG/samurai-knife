/** Proof-of-work contract shared by the server (`src/lib/accounts/pow.ts`), the browser and the worker. Pure. */

export const POW_FORMS = ["register", "forgot", "resend", "reset", "login"] as const;
export type PowForm = (typeof POW_FORMS)[number];

/** What a protected form posts as `pow`. */
export interface PowSolution {
  c: string;
  nonce: string;
}

/** `GET /api/account/challenge?form=` */
export interface PowChallenge {
  c: string;
  bits: number;
  expiresInSeconds: number;
}

/** Worker task map (`pow.worker.ts`): progress = hashes tried so far. */
export type PowTasks = {
  solve: { payload: { c: string; bits: number }; result: string; progress: number };
};
