/**
 * Proof-of-work solver for the sign-in forms (docs/ACCOUNTS.md "Proof of work"): find a decimal `nonce` such that
 * SHA-256(`${challenge}:${nonce}`) starts with `bits` zero bits. Pure TypeScript SHA-256 (no crypto.subtle: it does not
 * exist on plain-HTTP origins, and per-call promises would cost more than the hash), with the challenge prefix hashed
 * once (midstate) so each attempt costs one or two compression rounds. Runs in a Web Worker (`pow.worker.ts`), on the
 * main thread in slices when workers are unavailable, and in the unit tests against node:crypto.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const W = new Uint32Array(64);

/** One compression round of `block` (64 bytes at `offset`) into `state` (8 words). */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    W[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i += 1) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
  for (let i = 0; i < 64; i += 1) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0; state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0; state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0x7e) throw new Error("challenge must be ASCII");
    out[i] = code;
  }
  return out;
}

/** SHA-256 of an ASCII string as 8 big-endian words (tests compare it with node:crypto). */
export function sha256Words(text: string): Uint32Array {
  const bytes = ascii(text);
  const state = new Uint32Array(INIT);
  const full = Math.floor(bytes.length / 64);
  for (let i = 0; i < full; i += 1) compress(state, bytes, i * 64);
  const tail = new Uint8Array(bytes.length % 64 < 56 ? 64 : 128);
  tail.set(bytes.subarray(full * 64));
  tail[bytes.length % 64] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(tail.length - 4, bitLength >>> 0);
  for (let off = 0; off < tail.length; off += 64) compress(state, tail, off);
  return state;
}

/** Leading zero bits of a big-endian word sequence. */
export function leadingZeroBits(words: ArrayLike<number>): number {
  let count = 0;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] >>> 0;
    if (w === 0) {
      count += 32;
      continue;
    }
    return count + Math.clz32(w);
  }
  return count;
}

/** Leading zero bits of a byte sequence (the server's node:crypto digest). */
export function leadingZeroBitsOfBytes(bytes: ArrayLike<number>): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] & 0xff;
    if (b === 0) {
      count += 8;
      continue;
    }
    return count + Math.clz32(b) - 24;
  }
  return count;
}

export const MAX_NONCE_DIGITS = 16;

/**
 * Searches nonces `start` .. `start + count - 1`; the first that meets `bits`, or null. Deterministic: the same inputs
 * give the same nonce, so callers can resume in slices (`start` += `count`).
 */
export function searchNonce(challenge: string, bits: number, start: number, count: number): number | null {
  const prefix = ascii(`${challenge}:`);
  const mid = new Uint32Array(INIT);
  const full = Math.floor(prefix.length / 64);
  for (let i = 0; i < full; i += 1) compress(mid, prefix, i * 64);
  const rest = prefix.subarray(full * 64);
  const block = new Uint8Array(128);
  const view = new DataView(block.buffer);
  const state = new Uint32Array(8);
  const digits = new Uint8Array(MAX_NONCE_DIGITS);
  const end = start + count;
  for (let nonce = start; nonce < end; nonce += 1) {
    let n = nonce;
    let len = 0;
    do {
      digits[MAX_NONCE_DIGITS - 1 - len] = 48 + (n % 10);
      n = Math.floor(n / 10);
      len += 1;
    } while (n > 0);
    const msgLen = rest.length + len;
    const blocks = msgLen + 9 <= 64 ? 1 : 2;
    block.fill(0, 0, blocks * 64);
    block.set(rest, 0);
    block.set(digits.subarray(MAX_NONCE_DIGITS - len), rest.length);
    block[msgLen] = 0x80;
    const bitLength = (prefix.length + len) * 8;
    view.setUint32(blocks * 64 - 8, Math.floor(bitLength / 2 ** 32));
    view.setUint32(blocks * 64 - 4, bitLength >>> 0);
    state.set(mid);
    compress(state, block, 0);
    if (blocks === 2) compress(state, block, 64);
    if (leadingZeroBits(state) >= bits) return nonce;
  }
  return null;
}

/** Solves completely (tests, the no-worker fallback in slices uses searchNonce directly). */
export function solvePow(challenge: string, bits: number): string {
  const slice = 1 << 20;
  for (let start = 0; start < Number.MAX_SAFE_INTEGER; start += slice) {
    const found = searchNonce(challenge, bits, start, slice);
    if (found !== null) return String(found);
  }
  throw new Error("no nonce found");
}
