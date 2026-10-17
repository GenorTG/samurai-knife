import { searchNonce } from "./solve";
import type { PowTasks } from "./types";
import { serveTasks } from "../workers/runtime";

const SLICE = 200_000;

serveTasks<PowTasks>({
  solve: ({ c, bits }, context) => {
    for (let start = 0; start < Number.MAX_SAFE_INTEGER; start += SLICE) {
      const found = searchNonce(c, bits, start, SLICE);
      if (found !== null) return String(found);
      context.progress(start + SLICE);
    }
    throw new Error("no nonce found");
  },
});
