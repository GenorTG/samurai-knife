import { fetchSolution } from "@/lib/pow/client";
import type { PowForm, PowSolution } from "@/lib/pow/types";
import type { Reply } from "./api";

/** What the forms show (as `role=status`) while the browser solves a challenge. */
export const CHECKING_TEXT = "Checking your browser…";

/**
 * Sends a protected form (docs/ACCOUNTS.md "Proof of work"). `upfront`: solve before the first send (register, forgot,
 * resend, reset always need it); login sends without and solves only when the server answers 428. A 428 on a proof
 * (difficulty went up, challenge expired) fetches a new challenge, at most twice.
 */
export async function withChallenge<T>(
  form: PowForm,
  send: (pow: PowSolution | null) => Promise<Reply<T>>,
  options: { upfront: boolean; onChecking: () => void },
): Promise<Reply<T>> {
  let pow: PowSolution | null = null;
  const solve = async (): Promise<Reply<T> | null> => {
    options.onChecking();
    try {
      pow = await fetchSolution(form);
      return null;
    } catch (error) {
      return { ok: false, status: 0, code: "challenge_failed", message: `The browser check could not finish: ${error instanceof Error ? error.message : String(error)}. Try again.` };
    }
  };
  if (options.upfront) {
    const failed = await solve();
    if (failed) return failed;
  }
  for (let attempt = 0; ; attempt += 1) {
    const reply = await send(pow);
    if (reply.ok || reply.status !== 428 || attempt >= 2) return reply;
    const failed = await solve();
    if (failed) return failed;
  }
}
