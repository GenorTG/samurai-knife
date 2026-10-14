/** Decoded size of a data: URI payload. Pure. */

const encoder = new TextEncoder();

/** Bytes of a payload once its %XX escapes are decoded; every other character counts as its UTF-8 bytes (what a browser does). */
function percentDecodedLength(payload: string): number {
  let bytes = 0;
  let last = 0;
  for (const match of payload.matchAll(/%[0-9A-Fa-f]{2}/g)) {
    bytes += encoder.encode(payload.slice(last, match.index)).length + 1;
    last = match.index + 3;
  }
  return bytes + encoder.encode(payload.slice(last)).length;
}

/** Real byte length of the decoded payload: base64 ignores whitespace and `=` padding, plain payloads count percent escapes as one byte. */
export function dataUriByteLength(payload: string, isBase64: boolean): number {
  if (!isBase64) return percentDecodedLength(payload);
  const data = payload.replace(/%3D/gi, "=").replace(/\s+/g, "");
  const padding = /={1,2}$/.exec(data)?.[0].length ?? 0;
  const symbols = data.length - padding;
  return Math.floor((symbols * 3) / 4);
}
