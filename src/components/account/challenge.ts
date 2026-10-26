import { msgf } from "@/lib/i18n/msg";
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
  const solve = async (bits?: number): Promise<Reply<T> | null> => {
    options.onChecking();
    try {
      pow = await fetchSolution(form, undefined, bits);
      return null;
    } catch (error) {
      return { ok: false, status: 0, code: "challenge_failed", message: msgf("The browser check could not finish: {value}. Try again.", { value: error instanceof Error ? error.message : String(error) }) };
    }
  };
  if (options.upfront) {
    const failed = await solve();
    if (failed) return failed;
  }
  for (let attempt = 0; ; attempt += 1) {
    const reply = await send(pow);
    if (reply.ok || reply.status !== 428 || attempt >= 2) return reply;
    // The 428 names the difficulty (raised while an identifier or the server is under attack): ask for a challenge at it.
    const failed = await solve(reply.bits);
    if (failed) return failed;
  }
}
