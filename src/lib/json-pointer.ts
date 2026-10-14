export type JsonPointerResult =
  | { found: true; value: unknown; tokens: string[] }
  | { found: false; error: string; tokenIndex: number };

function decodeToken(token: string, index: number): string {
  if (/~(?![01])/.test(token)) throw new Error(`Invalid escape in pointer token ${index + 1}; only ~0 and ~1 are valid.`);
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(document: unknown, pointer: string): JsonPointerResult {
  if (pointer === "") return { found: true, value: document, tokens: [] };
  if (!pointer.startsWith("/")) {
    return { found: false, error: "A JSON Pointer must be empty (the whole document) or start with '/'.", tokenIndex: 0 };
  }

  let tokens: string[];
  try {
    tokens = pointer.slice(1).split("/").map(decodeToken);
  } catch (error) {
    return { found: false, error: error instanceof Error ? error.message : String(error), tokenIndex: 0 };
  }

  let value = document;
  for (const [index, token] of tokens.entries()) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) {
        return { found: false, error: `Array index '${token}' is not a canonical non-negative integer.`, tokenIndex: index };
      }
      const arrayIndex = Number(token);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= value.length) {
        return { found: false, error: `Array index ${token} is out of range.`, tokenIndex: index };
      }
      value = value[arrayIndex];
      continue;
    }

    if (value !== null && typeof value === "object") {
      if (!Object.prototype.hasOwnProperty.call(value, token)) {
        return { found: false, error: `Object property '${token}' does not exist.`, tokenIndex: index };
      }
      value = (value as Record<string, unknown>)[token];
      continue;
    }

    return { found: false, error: `Cannot follow '${token}' through a ${value === null ? "null" : typeof value} value.`, tokenIndex: index };
  }

  return { found: true, value, tokens };
}
