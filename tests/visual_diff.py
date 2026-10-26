"""Screenshot regression diff for every tool and suite tab (see docs/TESTING.md).

Subcommands:
  shoot <base_url> <out_dir> [--only substr] [--themes dark,light] [--widths 1440,390x844] [--selector main] [--browser firefox]
      Screenshots the launcher, every standalone tool and every suite tab (from
      src/lib/registry.ts), the account/admin/login pages, in each theme x width into <out_dir>/<theme>-<width>/.
      Animations, transitions and carets are disabled, Date/Math.random are frozen,
      the Next dev badge is hidden, so two servers with the same code give identical PNGs.
      Pages a server answers with 404 are skipped (listed in <out_dir>/missing.txt).
      A width may carry its height (390x844; default 900). --browser picks chromium (default) or firefox.
  diff <dir_a> <dir_b> [--threshold 0.002] [--top 30] [--montage dir]
      Compares same-named PNGs: share of pixels whose channel delta exceeds 24.
      Prints the pages above the threshold (worst first, at most --top lines) and,
      with --montage, writes before | after | diff strips for them.
  compare <url_a> <url_b> <out_dir> [shoot options] [diff options]
      shoot both servers (A = baseline, B = candidate) in parallel, then diff.
  audit <url> [--docked] [--widths 1440,390] [--only substr] [--top 30] [--theme light] [--contrast 3] [--lang pl]
      No screenshots: loads every page and lists layout offenders inside <main>: elements
      sticking out past its right edge (outside scroll containers), Stat cards whose value
      overflows, overlapping controls and horizontal page overflow. --contrast N also lists
      text under an N:1 contrast ratio against its (alpha-composited) background. --docked docks the assistant panel first
      (1440px: the tool gets ~750px) to catch viewport breakpoints that lie.

Usage: python3 tests/visual_diff.py compare http://127.0.0.1:3306 http://127.0.0.1:3305 .tmp/vd
Needs python `playwright` + chromium and `Pillow`.
"""
import argparse
import re
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

REGISTRY = Path(__file__).resolve().parent.parent / "src/lib/registry.ts"
STYLE = (
    "*,*::before,*::after{animation:none!important;transition:none!important;"
    "caret-color:transparent!important;scroll-behavior:auto!important}"
    "nextjs-portal,[data-nextjs-dev-tools-button],[data-next-badge-root]{display:none!important}"
)
INIT = """
(() => {
  const T = 1767225600000; // 2026-01-01T00:00:00Z
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...a) { a.length ? super(...a) : super(T); }
    static now() { return T; }
  }
  window.Date = FixedDate;
  let s = 12345;
  Math.random = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  try { localStorage.setItem('sk-theme', '%THEME%'); } catch (e) {}
})();
"""


def pages(registry: Path = REGISTRY) -> list[tuple[str, str]]:
    """(file stem, path) for the launcher, every standalone tool and every suite tab."""
    text = registry.read_text().split("export const SLUG_ALIASES")[0]
    out: list[tuple[str, str]] = [("launcher", "/")]
    current = ""
    seen_tabs: dict[str, list[str]] = {}
    order: list[str] = []
    for line in text.splitlines():
        m = re.match(r'^    slug:\s*"([^"]+)"', line)
        if m:
            current = m.group(1)
            order.append(current)
            continue
        t = re.match(r'^\s+\{ id: "([^"]+)", label:', line)
        if t and current:
            seen_tabs.setdefault(current, []).append(t.group(1))
    for slug in order:
        tabs = seen_tabs.get(slug)
        if not tabs:
            out.append((slug, f"/tools/{slug}"))
        else:
            out.extend((f"{slug}__{tab}", f"/tools/{slug}?tab={tab}") for tab in tabs)
    # pages outside the registry (404 in a mode that has no such page: listed in missing.txt)
    out += [("account", "/account"), ("account__admin", "/account/admin"), ("account__logs", "/account/admin/logs"),
            ("login", "/login"), ("register", "/register")]
    return out


def viewports(spec: str) -> list[tuple[int, int]]:
    """'1440,390x844' -> [(1440, 900), (390, 844)]."""
    out = []
    for part in spec.split(","):
        w, _, h = part.partition("x")
        out.append((int(w), int(h or 900)))
    return out


def launch(pw, browser: str):
    return pw.firefox.launch() if browser == "firefox" else pw.chromium.launch()


def shoot_page(page, base: str, stem: str, path: str, d: Path, selector: str) -> bool:
    """Screenshot one page; False when the server answers 404."""
    resp = page.goto(base + path, wait_until="domcontentloaded")
    if resp is None or resp.status == 404:
        return False
    page.add_style_tag(content=STYLE)
    try:
        page.wait_for_function("() => !document.body.innerText.includes('Loading tool')", timeout=15000)
    except Exception:
        pass
    page.wait_for_timeout(350)
    target = page.locator(selector).first if selector else None
    if target is not None and target.count():
        target.screenshot(path=str(d / f"{stem}.png"))
    else:
        page.screenshot(path=str(d / f"{stem}.png"), full_page=True)
    return True


def shoot(base: str, out_dir: Path, only: str, themes: list[str], widths: list[tuple[int, int]], selector: str = "", browser_name: str = "chromium") -> int:
    from playwright.sync_api import sync_playwright

    todo = [p for p in pages() if only in p[0]]
    missing: list[str] = []
    count = 0
    with sync_playwright() as pw:
        browser = launch(pw, browser_name)
        for theme in themes:
            for width, height in widths:
                ctx = browser.new_context(
                    viewport={"width": width, "height": height},
                    reduced_motion="reduce",
                    locale="en-US",
                    timezone_id="UTC",
                )
                ctx.add_init_script(INIT.replace("%THEME%", theme))
                page = ctx.new_page()
                d = out_dir / f"{theme}-{width}"
                d.mkdir(parents=True, exist_ok=True)
                for stem, path in todo:
                    for attempt in (1, 2):
                        try:
                            shot = shoot_page(page, base, stem, path, d, selector)
                            break
                        except Exception as exc:  # a crashed tab: reopen once, then give up on the page
                            if attempt == 2:
                                print(f"{base} {stem}: {type(exc).__name__}", file=sys.stderr)
                                shot = None
                            else:
                                page = ctx.new_page()
                    if shot is None:
                        continue
                    if shot is False:
                        if stem not in missing:
                            missing.append(stem)
                        continue
                    count += 1
                ctx.close()
        browser.close()
    (out_dir / "missing.txt").write_text("\n".join(missing))
    return count


AUDIT_JS = """
() => {
  const main = document.querySelector('main');
  if (!main) return ['no <main>'];
  const mr = main.getBoundingClientRect();
  const bad = [];
  const scrolled = (el) => {
    for (let p = el.parentElement; p && p !== main; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    }
    return false;
  };
  const name = (el) => el.tagName.toLowerCase() + '.' + String(el.className).split(/\\s+/).slice(0, 3).join('.');
  for (const el of main.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > mr.right + 1 && !scrolled(el)) bad.push('out ' + name(el) + ' +' + Math.round(r.right - mr.right));
  }
  for (const sec of main.querySelectorAll('section')) {
    const sr = sec.getBoundingClientRect();
    for (const el of sec.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.right <= sr.right + 1) continue;
      let inScroller = false;
      for (let p = el.parentElement; p && p !== sec; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') { inScroller = true; break; }
      }
      if (!inScroller) bad.push('panel ' + name(el) + ' +' + Math.round(r.right - sr.right));
    }
  }
  for (const ctl of main.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea')) {
    const r = ctl.getBoundingClientRect(), pr = ctl.parentElement.getBoundingClientRect();
    if (r.width && r.right > pr.right + 1) bad.push('ctl ' + name(ctl) + ' +' + Math.round(r.right - pr.right));
  }
  const ctls = document.querySelector('[data-launcher-search]') ? [] : [...main.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea,button')].filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  for (let i = 0; i < ctls.length; i++) {
    const a = ctls[i].getBoundingClientRect();
    for (let j = i + 1; j < Math.min(ctls.length, i + 12); j++) {
      const b = ctls[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 3 && h > 3 && !ctls[i].contains(ctls[j]) && !ctls[j].contains(ctls[i])) bad.push('overlap ' + name(ctls[i]) + ' x ' + name(ctls[j]));
    }
  }
  for (const cell of main.querySelectorAll('[class*="bg-raised/50"]')) {
    if (cell.querySelector('.sk-label') && cell.scrollWidth > cell.clientWidth + 1) bad.push('stat ' + (cell.querySelector('.sk-label').textContent || '').slice(0, 24));
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page-x ' + document.documentElement.scrollWidth);
  return bad.slice(0, 4);
}
"""



CONTRAST_JS = """
(min) => {
  // computed colors can be oklab()/oklch() (Tailwind opacity modifiers, color-mix): let a canvas normalize them to sRGBA
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const parse = (c) => {
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = '#000';
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    const stack = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    const root = parse(getComputedStyle(document.body).backgroundColor);
    if (root.a >= 1) base = root;
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent || '').trim();
    const el = n.parentElement;
    if (!t || !el || seen.has(el) || !el.getClientRects().length) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || el.closest('[disabled],[aria-disabled=true]')) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    const fg = over(parse(cs.color), bg);
    const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    if (ratio < min) out.push(ratio.toFixed(1) + ' ' + t.slice(0, 22));
  }
  return out;
}
"""

def audit(base: str, only: str, widths: list[tuple[int, int]], docked: bool, top: int, theme: str = "dark", contrast: float = 0, browser_name: str = "chromium", lang: str = "") -> int:
    from playwright.sync_api import sync_playwright

    todo = [p for p in pages() if only in p[0]]
    found: list[str] = []
    with sync_playwright() as pw:
        browser = launch(pw, browser_name)
        for width, height in widths:
            ctx = browser.new_context(viewport={"width": width, "height": height}, reduced_motion="reduce")
            ctx.add_init_script(f"localStorage.setItem('sk-theme', '{theme}')")
            if lang:
                ctx.add_cookies([{"name": "knife_lang", "value": lang, "url": base}])
            if docked:
                ctx.add_init_script(
                    "localStorage.setItem('sk.agent.ui.v1', JSON.stringify({open:true,width:400,height:560,dock:true}))"
                )
            page = ctx.new_page()
            for stem, path in todo:
                try:
                    resp = page.goto(base + path, wait_until="domcontentloaded")
                    if resp is None or resp.status == 404:
                        continue
                    page.add_style_tag(content=STYLE)
                    try:
                        page.wait_for_function("() => !/Loading tool|Wczytywanie narzędzia/.test(document.body.innerText)", timeout=15000)
                    except Exception:
                        pass
                    page.wait_for_timeout(300)
                    bad = page.evaluate(AUDIT_JS)
                    if contrast:
                        low = page.evaluate(CONTRAST_JS, contrast)
                        if low:
                            bad = bad + [f"contrast {len(low)}x: " + " | ".join(low[:3])]
                except Exception as exc:
                    bad = [f"error {type(exc).__name__}"]
                if bad:
                    found.append(f"{width}{'d' if docked else ''} {stem}: " + "; ".join(bad[:3]))
            ctx.close()
        browser.close()
    print(f"audited {len(todo)} pages x {len(widths)} widths{' (docked)' if docked else ''}: {len(found)} with offenders")
    for line in found[:top]:
        print("  " + line[:170])
    if len(found) > top:
        print(f"  ... {len(found) - top} more")
    return len(found)


def diff_dirs(a: Path, b: Path, threshold: float, top: int, montage: Path | None) -> list[tuple[float, str]]:
    from PIL import Image, ImageChops

    rows: list[tuple[float, str, str]] = []
    total = 0
    for fa in sorted(a.glob("*/*.png")):
        fb = b / fa.parent.name / fa.name
        if not fb.exists():
            continue
        total += 1
        ia, ib = Image.open(fa).convert("RGB"), Image.open(fb).convert("RGB")
        w, h = max(ia.width, ib.width), max(ia.height, ib.height)
        ca = Image.new("RGB", (w, h), (255, 0, 255))
        cb = Image.new("RGB", (w, h), (255, 0, 255))
        ca.paste(ia)
        cb.paste(ib)
        delta = ImageChops.difference(ca, cb).convert("L").point(lambda v: 255 if v > 24 else 0)
        frac = sum(1 for v in delta.getdata() if v) / (w * h)
        note = "" if ia.size == ib.size else f"size {ia.size}->{ib.size}"
        label = f"{fa.parent.name}/{fa.stem}"
        rows.append((frac, label, note))
        if montage and frac > threshold:
            montage.mkdir(parents=True, exist_ok=True)
            hh = min(h, 2400)
            strip = Image.new("RGB", (w * 3 + 20, hh), (40, 40, 40))
            strip.paste(ca.crop((0, 0, w, hh)), (0, 0))
            strip.paste(cb.crop((0, 0, w, hh)), (w + 10, 0))
            strip.paste(delta.crop((0, 0, w, hh)).convert("RGB"), (2 * w + 20, 0))
            strip.save(montage / f"{label.replace('/', '__')}.png")
    rows.sort(reverse=True)
    over = [r for r in rows if r[0] > threshold]
    print(f"compared {total} pairs; {len(over)} above {threshold:.4f}")
    for frac, label, note in over[:top]:
        print(f"  {frac:.4f}  {label}  {note}")
    if len(over) > top:
        print(f"  ... {len(over) - top} more")
    return [(r[0], r[1]) for r in over]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def shoot_opts(p: argparse.ArgumentParser) -> None:
        p.add_argument("--only", default="")
        p.add_argument("--themes", default="dark,light")
        p.add_argument("--widths", default="1440,390")
        p.add_argument("--selector", default="", help="screenshot only this element (e.g. main: the tool without shell chrome)")
        p.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")

    def diff_opts(p: argparse.ArgumentParser) -> None:
        p.add_argument("--threshold", type=float, default=0.002)
        p.add_argument("--top", type=int, default=30)
        p.add_argument("--montage", type=Path)

    s = sub.add_parser("shoot")
    s.add_argument("url")
    s.add_argument("out", type=Path)
    shoot_opts(s)
    d = sub.add_parser("diff")
    d.add_argument("a", type=Path)
    d.add_argument("b", type=Path)
    diff_opts(d)
    a = sub.add_parser("audit")
    a.add_argument("url")
    a.add_argument("--docked", action="store_true")
    a.add_argument("--widths", default="1440,390")
    a.add_argument("--only", default="")
    a.add_argument("--top", type=int, default=30)
    a.add_argument("--theme", default="dark")
    a.add_argument("--contrast", type=float, default=0)
    a.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    a.add_argument("--lang", default="", help="interface language (knife_lang cookie): en or pl")
    c = sub.add_parser("compare")
    c.add_argument("url_a")
    c.add_argument("url_b")
    c.add_argument("out", type=Path)
    shoot_opts(c)
    diff_opts(c)
    args = ap.parse_args()

    if args.cmd == "shoot":
        n = shoot(args.url.rstrip("/"), args.out, args.only, args.themes.split(","), viewports(args.widths), args.selector, args.browser)
        print(f"{n} screenshots in {args.out}")
        return 0
    if args.cmd == "diff":
        diff_dirs(args.a, args.b, args.threshold, args.top, args.montage)
        return 0
    if args.cmd == "audit":
        audit(args.url.rstrip("/"), args.only, viewports(args.widths), args.docked, args.top, args.theme, args.contrast, args.browser, args.lang)
        return 0
    themes, widths = args.themes.split(","), viewports(args.widths)
    with ProcessPoolExecutor(2) as ex:
        fa = ex.submit(shoot, args.url_a.rstrip("/"), args.out / "a", args.only, themes, widths, args.selector, args.browser)
        fb = ex.submit(shoot, args.url_b.rstrip("/"), args.out / "b", args.only, themes, widths, args.selector, args.browser)
        print(f"shot a={fa.result()} b={fb.result()}")
    diff_dirs(args.out / "a", args.out / "b", args.threshold, args.top, args.montage or args.out / "montage")
    return 0


if __name__ == "__main__":
    sys.exit(main())
