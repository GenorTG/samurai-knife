/** Search URLs for job boards. We build links for the user to open; the app never scrapes boards. Pure. */

export interface BoardLink {
  board: string;
  url: string;
}

/** Python `quote` / `quote_plus` equivalents: encode everything except unreserved characters. */
const quote = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const quotePlus = (s: string): string => quote(s).replace(/%20/g, "+");

export function boardLinks(query: string, location = "", remote = false): BoardLink[] {
  const q = query.trim();
  const loc = location.trim();
  const pracuj = `https://www.pracuj.pl/praca/${quote(q)};kw${loc ? `/${quote(loc)};wp` : ""}${remote ? "?wm=home-office" : ""}`;
  const justjoinPlace = remote ? "remote" : loc ? quote(loc.toLowerCase()) : "all-locations";
  const siteQuery = quotePlus([q, loc].filter(Boolean).join(" "));
  return [
    { board: "pracuj.pl", url: pracuj },
    { board: "justjoin.it", url: `https://justjoin.it/job-offers/${justjoinPlace}?keyword=${quotePlus(q)}` },
    // NoFluffJobs has no stable public search URL: a site: search is the reliable way in.
    { board: "nofluffjobs.com", url: `https://www.google.com/search?q=${siteQuery}+site%3Anofluffjobs.com%2Fpl%2Fjob` },
    { board: "linkedin.com/jobs", url: `https://www.linkedin.com/jobs/search/?keywords=${quotePlus(q)}${loc ? `&location=${quotePlus(loc)}` : ""}${remote ? "&f_WT=2" : ""}` },
    { board: "pl.indeed.com", url: `https://pl.indeed.com/jobs?q=${quotePlus(q)}${loc ? `&l=${quotePlus(loc)}` : ""}${remote ? "&sc=0kf%3Aattr%28DSQF7%29%3B" : ""}` },
  ];
}
