/** Whether a file matches an `<input accept>` list (".png,image/*,application/pdf"); empty = anything. */
export function accepts(accept: string, file: { name: string; mime: string }): boolean {
  const tokens = accept.split(",").map((token) => token.trim().toLowerCase()).filter(Boolean);
  if (!tokens.length) return true;
  const name = file.name.toLowerCase();
  const mime = file.mime.toLowerCase();
  return tokens.some((token) => (token.startsWith(".") ? name.endsWith(token) : token.endsWith("/*") ? mime.startsWith(token.slice(0, -1)) : mime === token));
}
