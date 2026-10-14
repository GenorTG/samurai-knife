/** cURL command text for the builder. Pure. */

export interface CurlInput {
  method: string;
  url: string;
  headers: string;
  body: string;
}

export interface CurlCommand {
  command: string;
  /** True when a body was typed but left out because the method cannot carry one. */
  bodyDropped: boolean;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCurlCommand({ method, url, headers, body }: CurlInput): CurlCommand {
  const head = method === "HEAD";
  const lines = [head ? `curl --head ${shellQuote(url)}` : `curl --request ${shellQuote(method)} ${shellQuote(url)}`];
  for (const line of headers.split(/\r?\n/).filter((item) => item.trim())) lines.push(`  --header ${shellQuote(line)}`);
  // --data-raw makes curl switch a HEAD request to POST, so a HEAD never carries the body.
  if (body && !head) lines.push(`  --data-raw ${shellQuote(body)}`);
  return { command: lines.join(" \\\n"), bodyDropped: head && body !== "" };
}
