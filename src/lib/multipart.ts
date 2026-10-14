/** MIME multipart body splitting (the multipart decoder). Pure, text only. */

export interface MultipartPart {
  headers: string;
  body: string;
}

export interface MultipartResult {
  parts: MultipartPart[];
  error: string;
}

/** Splits one part (the text between two delimiters) into its header block and body. */
function splitPart(chunk: string): MultipartPart {
  // The line break after the delimiter (plus optional transport padding) and the one before the next delimiter belong to the framing.
  const clean = chunk.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n$/, "");
  // An empty header block is a blank line straight after the delimiter: everything after it is body.
  const empty = /^\r?\n/.exec(chunk.replace(/^[ \t]*\r?\n/, ""));
  if (empty) return { headers: "", body: clean.slice(empty[0].length) };
  const split = clean.search(/\r?\n\r?\n/);
  if (split < 0) return { headers: "", body: clean };
  return { headers: clean.slice(0, split), body: clean.slice(split).replace(/^\r?\n\r?\n/, "") };
}

export function decodeMultipart(boundary: string, input: string): MultipartResult {
  if (!boundary) return { parts: [], error: "Enter a boundary." };
  const token = `--${boundary}`;
  if (!input.includes(token)) return { parts: [], error: `Boundary "${boundary}" not found in the body (delimiters are "--" + boundary).` };
  const all = input.split(token).slice(1);
  const end = all.findIndex((chunk) => chunk.startsWith("--")); // "--boundary--" closes the body; the rest is epilogue
  const chunks = (end < 0 ? all : all.slice(0, end)).filter((chunk) => chunk.trim() !== "");
  return { parts: chunks.map(splitPart), error: "" };
}
