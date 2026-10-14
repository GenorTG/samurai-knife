"""Functional e2e for the CSS + time/text suites (real UI, independent oracles).

Tools/tabs: box-shadow (shadow, radius, easing), css-grid (grid, clamp, type-scale),
css-var-resolver (variables, tokens), heading-audit (headings, links, forms, landmarks),
reading-grade (grade, sentences, punctuation, words), meeting-timezones (meeting, overlap,
dst, workdays, cron, recurrence).

Usage: python3 tests/functional/css_time_e2e.py [base_url]    (default http://127.0.0.1:3210)
Never contacts an AI provider. Exits nonzero on any FAIL.
"""
import re
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from dateutil import rrule
from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3210").rstrip("/")
FAILS: list[str] = []
ERRORS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"ok   {name}")
    else:
        print(f"FAIL {name} {detail}")
        FAILS.append(name)


def eq(name: str, got, want) -> None:
    check(name, got == want, f"\n     got:  {got!r}\n     want: {want!r}")


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def js(n: float, d: int) -> str:
    """JS Number.toFixed equivalent (exact binary value, half away on exact ties)."""
    from decimal import ROUND_HALF_UP, Decimal
    return str(Decimal(n).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


def stat(page, label: str) -> str:
    return norm(page.locator(".sk-label", has_text=re.compile(rf"^{re.escape(label)}$")).first
                .locator("xpath=following-sibling::*[1]").inner_text())


def open_tab(page, slug: str, tab: str, vw: int = 1280) -> None:
    page.set_viewport_size({"width": vw, "height": 900})
    page.goto(f"{BASE}/tools/{slug}?tab={tab}", wait_until="networkidle")
    page.get_by_role("tab", selected=True).wait_for()
    page.wait_for_function("document.querySelector('[role=tabpanel] [aria-busy]')===null")


def no_overflow(page, name: str) -> None:
    page.set_viewport_size({"width": 390, "height": 800})
    page.wait_for_timeout(150)
    sw = page.evaluate("document.documentElement.scrollWidth")
    check(f"{name}: no horizontal overflow at 390px", sw <= 390, f"scrollWidth={sw}")
    page.set_viewport_size({"width": 1280, "height": 900})


def seen(page, text: str) -> bool:
    try:
        page.get_by_text(text).first.wait_for(timeout=2500)
        return True
    except Exception:  # noqa: BLE001
        return False


def read_clip(page) -> str:
    return page.evaluate("navigator.clipboard.readText()")


def fill(page, label: str, value: str) -> None:
    page.get_by_label(label).fill(value)


# ---------------------------------------------------------------------------- box-shadow
def t_shadow(page):
    open_tab(page, "box-shadow", "shadow")
    code = page.locator("code").first
    eq("shadow: default css", code.inner_text(), "box-shadow: 0px 12px 28px 0px rgba(0, 0, 0, 0.24);")
    fill(page, "X offset", "4"); fill(page, "Y offset", "-6"); fill(page, "Blur", "10")
    fill(page, "Spread", "2"); fill(page, "Opacity (%)", "50")
    hexin = page.locator('input[aria-label="Shadow color hex"]')
    hexin.click(); page.keyboard.press("Control+a"); page.keyboard.type("#336699", delay=20)
    eq("shadow: hex typed key-by-key accepted", hexin.input_value(), "#336699")
    page.get_by_label("Placement").select_option("inset")
    want = f"box-shadow: inset 4px -6px 10px 2px rgba({0x33}, {0x66}, {0x99}, 0.50);"
    eq("shadow: css after edits", code.inner_text(), want)
    got = page.evaluate("getComputedStyle([...document.querySelectorAll('div')].find(d=>d.textContent==='Preview'&&d.className.includes('rounded-xl'))).boxShadow")
    check("shadow: preview computed style applies it", "rgba(51, 102, 153, 0.5)" in got and "inset" in got, got)
    hexin.click(); page.keyboard.press("Control+a"); page.keyboard.type("#12", delay=20)
    eq("shadow: partial/invalid hex does not change css", code.inner_text(), want)
    fill(page, "Blur", "-40"); fill(page, "Opacity (%)", "500")
    check("shadow: negative blur / opacity>100 clamped",
          "0px 2px rgba(51, 102, 153, 1.00)" in code.inner_text() or "10px" not in code.inner_text() and "1.00)" in code.inner_text(), code.inner_text())
    page.get_by_role("button", name="Copy CSS").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("shadow: copied text == displayed css", read_clip(page), code.inner_text())
    no_overflow(page, "shadow")


def t_radius(page):
    open_tab(page, "box-shadow", "radius")
    code = page.locator("code").first
    eq("radius: default", code.inner_text(), "border-radius: 24% 24% 24% 24%;")
    for lab, v in [("Top left horizontal (%)", "10"), ("Top right horizontal (%)", "20"),
                   ("Bottom right horizontal (%)", "30"), ("Bottom left horizontal (%)", "150")]:
        fill(page, lab, v)
    eq("radius: values + clamp 150->100", code.inner_text(), "border-radius: 10% 20% 30% 100%;")
    page.get_by_label("Use elliptical vertical radii").check()
    for lab, v in [("Top left vertical (%)", "50"), ("Top right vertical (%)", "60"),
                   ("Bottom right vertical (%)", "70"), ("Bottom left vertical (%)", "80")]:
        fill(page, lab, v)
    eq("radius: elliptical", code.inner_text(), "border-radius: 10% 20% 30% 100% / 50% 60% 70% 80%;")
    br = page.evaluate("[...document.querySelectorAll('div')].find(d=>d.textContent==='Preview'&&d.style.borderRadius).style.borderRadius")
    check("radius: preview uses it", br.startswith("10% 20% 30% 100%") and "50% 60% 70% 80%" in br, br)
    page.get_by_role("button", name="Copy CSS").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("radius: clipboard", read_clip(page), code.inner_text())
    no_overflow(page, "radius")


def t_easing(page):
    open_tab(page, "box-shadow", "easing")
    code = page.locator("code").first
    eq("easing: default", code.inner_text(), "transition-timing-function: cubic-bezier(0.25, 0.10, 0.25, 1.00);")
    fill(page, "Control point 1 X (0–1)", "0.42"); fill(page, "Control point 1 Y (overshoot allowed)", "-0.5")
    fill(page, "Control point 2 X (0–1)", "5"); fill(page, "Control point 2 Y (overshoot allowed)", "1.5")
    eq("easing: values, X clamped to 1", code.inner_text(),
       "transition-timing-function: cubic-bezier(0.42, -0.50, 1.00, 1.50);")
    d = page.locator('svg[aria-label="Cubic Bezier easing curve"] path').nth(1).get_attribute("d")
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", d)]
    want = [20, 180, 20 + 0.42 * 200, 180 + 0.5 * 160, 220, 180 - 1.5 * 160, 220, 20]
    check("easing: svg path matches control points", all(abs(a - b) < 1e-6 for a, b in zip(nums, want)) and len(nums) == 8, f"{d}")
    page.get_by_role("button", name="Play preview").click()
    check("easing: play toggles", page.get_by_role("button", name="Reset preview").count() == 1)
    ball = page.evaluate("(()=>{const b=document.querySelector('.bg-accent.rounded-full');return b.style.transition})()")
    check("easing: preview transition uses curve", "cubic-bezier(0.42, -0.5, 1, 1.5)" in ball, ball)
    page.get_by_role("button", name="Copy CSS").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("easing: clipboard", read_clip(page), code.inner_text())
    no_overflow(page, "easing")


# ---------------------------------------------------------------------------- css-grid
def t_grid(page):
    open_tab(page, "css-grid", "grid")
    pre = page.locator("pre").first
    eq("grid: default css", pre.inner_text(),
       "display: grid;\ngrid-template-columns: repeat(3, minmax(0, 1fr));\ngrid-template-rows: repeat(2, minmax(4rem, auto));\ngap: 12px;")
    fill(page, "Columns", "4"); fill(page, "Rows", "3"); fill(page, "Gap (px)", "20"); fill(page, "Items", "9")
    eq("grid: css after edit", pre.inner_text(),
       "display: grid;\ngrid-template-columns: repeat(4, minmax(0, 1fr));\ngrid-template-rows: repeat(3, minmax(4rem, auto));\ngap: 20px;")
    info = page.evaluate("(()=>{const g=document.querySelector('[aria-label=\"Grid preview\"]');const cs=getComputedStyle(g);"
                         "return {n:g.children.length,cols:cs.gridTemplateColumns.split(' ').length,rows:cs.gridTemplateRows.split(' ').length,gap:cs.columnGap,last:g.lastElementChild.textContent}})()")
    eq("grid: preview items/tracks/gap", (info["n"], info["cols"], info["rows"], info["gap"], info["last"]), (9, 4, 3, "20px", "9"))
    fill(page, "Columns", "99"); fill(page, "Items", "0")
    check("grid: columns clamped to 12, items min 1", "repeat(12," in pre.inner_text() and
          page.evaluate("document.querySelector('[aria-label=\"Grid preview\"]').children.length") == 1)
    page.get_by_role("button", name="Copy CSS").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    clip = read_clip(page)
    check("grid: clipboard wraps css in .grid rule", clip.startswith(".grid {\n  display: grid;") and clip.endswith("gap: 20px;\n}"), clip)
    no_overflow(page, "grid")


def clamp_expect(mn, mx, w0, w1):
    slope = (mx - mn) / max(1, w1 - w0) * 100
    inter = mn - slope * w0 / 100
    return f"clamp({mn}px, {js(inter, 2)}px + {js(slope, 3)}vw, {mx}px)", js(slope, 3)


def t_clamp(page):
    open_tab(page, "css-grid", "clamp")
    val, slope = clamp_expect(16, 32, 360, 1440)
    eq("clamp: default value", stat(page, "Generated value"), val)
    eq("clamp: default slope", stat(page, "Fluid slope"), slope + "vw")
    fill(page, "Minimum size (px)", "14"); fill(page, "Maximum size (px)", "22")
    fill(page, "Minimum viewport (px)", "320"); fill(page, "Maximum viewport (px)", "1280")
    val, slope = clamp_expect(14, 22, 320, 1280)
    eq("clamp: edited value", stat(page, "Generated value"), val)
    # Independent numeric check: evaluated at 800px viewport should be linear interpolation
    m = re.match(r"clamp\((\d+)px, (-?[\d.]+)px \+ ([\d.]+)vw, (\d+)px\)", val)
    at800 = float(m.group(2)) + float(m.group(3)) * 8
    check("clamp: interpolates ~18px at 800px viewport", abs(at800 - (14 + 8 * (800 - 320) / 960)) < 0.02, str(at800))
    page.get_by_role("button", name="Copy CSS").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("clamp: clipboard", read_clip(page), f"font-size: {val};")
    no_overflow(page, "clamp")


def t_typescale(page):
    open_tab(page, "css-grid", "type-scale")
    fill(page, "Base size (px)", "18"); fill(page, "Scale ratio", "1.2")
    lines = [f"  --type-{'minus-' + str(abs(i)) if i < 0 else i}: {js(18 * 1.2 ** i, 2)}px;" for i in range(-2, 6)]
    want = ":root {\n" + "\n".join(lines) + "\n}"
    eq("type-scale: tokens", page.locator("pre").first.inner_text(), want)
    rows = norm(page.locator("code.text-xs").first.inner_text())
    eq("type-scale: top row px / rem", rows, f"{js(18 * 1.2 ** 5, 2)}px / {js(18 * 1.2 ** 5 / 16, 3)}rem")
    page.get_by_role("button", name="Copy CSS tokens").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("type-scale: clipboard", read_clip(page), want)
    fill(page, "Base size (px)", "500")
    page.get_by_label("Base size (px)").press("Tab")  # the clamp is shown once editing ends, not on every key
    eq("type-scale: base clamped to 64 on blur", page.get_by_label("Base size (px)").input_value(), "64")
    # Real key presses: a clamp on every keystroke made 1.5 and 24 impossible to type (regression, 2026-10-10).
    ratio, base = page.get_by_label("Scale ratio"), page.get_by_label("Base size (px)")
    ratio.click(); page.keyboard.press("Control+A"); page.keyboard.type("1.5")
    eq("type-scale: typed ratio text", ratio.input_value(), "1.5")
    base.click(); page.keyboard.press("Control+A"); page.keyboard.type("24")
    eq("type-scale: typed base text", base.input_value(), "24")
    lines = [f"  --type-{'minus-' + str(abs(i)) if i < 0 else i}: {js(24 * 1.5 ** i, 2)}px;" for i in range(-2, 6)]
    eq("type-scale: tokens follow typed values", page.locator("pre").first.inner_text(), ":root {\n" + "\n".join(lines) + "\n}")
    page.keyboard.press("Control+A"); page.keyboard.type("5"); page.keyboard.press("Enter")
    eq("type-scale: Enter normalises 5 -> 8", base.input_value(), "8")
    page.keyboard.press("Control+A"); page.keyboard.press("Backspace"); page.keyboard.press("Tab")
    eq("type-scale: blank base -> 16", base.input_value(), "16")
    ratio.click(); page.keyboard.press("Control+A"); page.keyboard.type("1"); page.keyboard.press("Tab")
    eq("type-scale: ratio 1 -> 1.05 on blur", ratio.input_value(), "1.05")
    no_overflow(page, "type-scale")


# ---------------------------------------------------------------------------- css-var-resolver
def t_resolver(page):
    open_tab(page, "css-var-resolver", "variables")
    eq("resolver: sample --card-gap", page.get_by_label("Resolved value").input_value(), "calc(8px * 2)")
    check("resolver: success notice", seen(page, "All referenced custom properties resolved."))
    css = (":root{ --a: 4px; --b: var(--a); --pad: var(--missing, calc(var(--b) * 3)); "
           "--fb: var(--nope, 10px) var(--b); --x: var(--y); --y: var(--x); --z: var(--nope); }")
    fill(page, "CSS custom-property declarations", css)
    sel = page.get_by_label("Token to resolve")
    out = page.get_by_label("Resolved value")
    sel.select_option("--pad")
    eq("resolver: fallback with nested calc/var()", out.input_value(), "calc(4px * 3)")
    check("resolver: --pad clean", seen(page, "All referenced custom properties resolved."))
    sel.select_option("--fb")
    eq("resolver: literal fallback + var", out.input_value(), "10px 4px")
    sel.select_option("--z")
    check("resolver: undefined token error", "Undefined token(s): --nope" in page.locator("body").inner_text())
    eq("resolver: undefined placeholder", out.input_value(), "<missing:--nope>")
    sel.select_option("--x")
    check("resolver: cycle error", "Cycle(s): --x → --y → --x" in norm(page.locator("body").inner_text()))
    # editing so the selected token disappears must not leave the select out of sync
    fill(page, "CSS custom-property declarations", ":root{--only: 1px;}")
    eq("resolver: select follows removed token", sel.input_value(), "--only")
    eq("resolver: shows resolved --only", out.input_value(), "1px")
    fill(page, "CSS custom-property declarations", "no tokens here")
    check("resolver: no tokens -> hint notice", seen(page, "Select a token declared"))
    no_overflow(page, "resolver")


def t_tokens(page):
    open_tab(page, "css-var-resolver", "tokens")
    ta = page.get_by_label("CSS custom-property declarations")
    bad = ":root {\n  --color-brand: #7658e8; /* brand */\n  --space: 1rem;\n  --space: 2rem;\n  --gap: var(--space-xl);\n  --empty:;\n  color: red;\n}"
    ta.fill(bad)
    eq("tokens: defined count", stat(page, "Defined tokens"), "4")
    eq("tokens: var() refs", stat(page, "var() references"), "1")
    eq("tokens: issues", stat(page, "Issues"), "4")
    t = page.locator("span.whitespace-pre-wrap").inner_text()
    for frag in ["Line 4: duplicate token --space (first on line 3).", "Line 5: reference to undefined --space-xl.",
                 "Line 6: --empty has an empty value.", "Line 7: declaration is not a --custom-property token."]:
        check(f"tokens: reports '{frag[:34]}'", frag in t, t)
    ta.fill(":root{--p:1px;--q:var(--p)}")
    eq("tokens: compact css defined", stat(page, "Defined tokens"), "2")
    eq("tokens: compact css issues", stat(page, "Issues"), "0")
    check("tokens: good notice", seen(page, "No duplicate declarations"))
    page.get_by_role("button", name="Copy token names").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("tokens: clipboard token names", read_clip(page), "--p\n--q")
    no_overflow(page, "tokens")


# ---------------------------------------------------------------------------- heading-audit
def audit(page, text: str, button: str) -> None:
    page.get_by_label("HTML fragment (not executed)").fill(text)
    page.get_by_role("button", name=button).click()


def t_headings(page):
    open_tab(page, "heading-audit", "headings")
    doc = ("<!doctype html><html><head><title>x</title></head><body><header><h1>Acme</h1></header><main>"
           "<h1>Dup</h1><h2>Section <em>A</em></h2><h4>Skipped</h4><h3></h3></main></body></html>")
    audit(page, doc, "Audit headings")
    eq("headings: count", stat(page, "Headings"), "5")
    items = [norm(x) for x in page.locator("ol li").all_inner_texts()]
    eq("headings: list", items, ["H1Acme", "H1Dup", "H2Section A", "H4Skipped", "H3(empty heading)"])
    t = page.locator("span.whitespace-pre-wrap").inner_text()
    eq("headings: issues", t.split("\n"), ["More than one H1 heading was found.", "Heading level jumps from H2 to H4: Skipped"])
    audit(page, "<h1>Title</h1><h2>One</h2><h3>Deep</h3><h2>Two</h2>", "Audit headings")
    check("headings: clean doc good notice", seen(page, "No skipped levels or duplicate H1 headings detected."))
    audit(page, "<p>No headings at all</p>", "Audit headings")
    check("headings: none found -> visible error", "No headings found." in page.locator("body").inner_text())
    no_overflow(page, "headings")


def t_links(page):
    open_tab(page, "heading-audit", "links")
    doc = ('<main><a href="/docs">Read more</a><a href="/about"><img src="a.png" alt="About the team"></a>'
           '<a href="/empty"></a><span id="lbl">Pricing details</span><a href="/p" aria-labelledby="lbl">x</a>'
           '<a href="/ok" aria-label="Download the annual report">PDF</a><a href="/c">Click here</a></main>')
    audit(page, doc, "Find link issues")
    eq("links: total", stat(page, "Links"), "6")
    eq("links: issues", stat(page, "Potential issues"), "3")
    rows = [norm(r) for r in page.locator("div.rounded-lg.border.p-3").all_inner_texts()]
    eq("links: rows", rows, ["/docs Read more Generic link text", "/about About the team", "/empty (empty) No accessible link name",
                              "/p Pricing details", "/ok Download the annual report", "/c Click here Generic link text"])
    no_overflow(page, "links")


def t_forms(page):
    open_tab(page, "heading-audit", "forms")
    doc = ('<form><label for="email">Email</label><input id="email" type="email">'
           '<label>Name <input type="text" id="nm"></label><span id="l2">Phone</span><input type="tel" aria-labelledby="l2">'
           '<input type="search" placeholder="Search"><select id="s"></select><textarea aria-label="Notes"></textarea>'
           '<input type="hidden" name="csrf"><input type="submit" value="Send"><button>Go</button></form>')
    audit(page, doc, "Audit form controls")
    eq("forms: controls (hidden/submit excluded)", stat(page, "Controls"), "6")
    eq("forms: unlabeled", stat(page, "Unlabeled"), "2")
    rows = [norm(r) for r in page.locator("div.rounded-lg.border.p-3.text-sm").all_inner_texts()]
    eq("forms: rows", rows, ["input · email · #email Named", "input · text · #nm Named", "input · tel Named",
                              "input · search Missing associated label / accessible name",
                              "select · #s Missing associated label / accessible name", "textarea Named"])
    audit(page, "<p>nothing</p>", "Audit form controls")
    check("forms: no controls notice", seen(page, "No form controls found."))
    no_overflow(page, "forms")


def t_landmarks(page):
    open_tab(page, "heading-audit", "landmarks")
    doc = ('<header>S</header><nav aria-label="P"></nav><nav aria-label="F"></nav><main><article>c</article>'
           '<aside>a</aside><div role="search"></div></main><footer>L</footer>')
    audit(page, doc, "Check landmarks")
    want = {"main": "1", "navigation": "2", "banner": "1", "contentinfo": "1", "complementary": "1", "search": "1", "region": "0"}
    for k, v in want.items():
        eq(f"landmarks: {k}", stat(page, k), v)
    check("landmarks: single main good", seen(page, "Exactly one main landmark found."))
    audit(page, "<main>a</main><div role='main'>b</div>", "Check landmarks")
    check("landmarks: two mains flagged", "Multiple main landmarks found." in page.locator("body").inner_text())
    audit(page, "<nav></nav><p>x</p>", "Check landmarks")
    check("landmarks: no main flagged", "No main landmark found." in page.locator("body").inner_text())
    no_overflow(page, "landmarks")


# ---------------------------------------------------------------------------- reading-grade
def syl(w: str) -> int:
    c = re.sub(r"[^a-z]", "", w.lower())
    if not c:
        return 0
    if len(c) <= 3:
        return 1
    g = len(re.findall(r"[aeiouy]+", c))
    return max(1, g - (1 if c.endswith("e") and not c.endswith("le") else 0))


def readability(text: str):
    words = re.findall(r"[A-Za-z]+(?:['’][A-Za-z]+)*", text)
    sents = max(1, len(re.findall(r"[.!?]+", text)))
    n = len(words)
    sy = sum(syl(w) for w in words)
    asl, asw = n / sents, sy / n
    cx = sum(1 for w in words if syl(w) >= 3)
    return (js(206.835 - 1.015 * asl - 84.6 * asw, 1), js(0.39 * asl + 11.8 * asw - 15.59, 1),
            js(0.4 * (asl + 100 * cx / n), 1), str(n), str(sents), str(sy))


def t_grade(page):
    open_tab(page, "reading-grade", "grade")
    ta = page.get_by_label("English prose")

    def got():
        return (stat(page, "Flesch reading ease"), stat(page, "Flesch–Kincaid grade"), stat(page, "Gunning Fog index"),
                stat(page, "Words"), stat(page, "Sentences (estimated)"), stat(page, "Syllables (estimated)"))
    easy = "The cat sat on the mat. The dog ran to the log."
    ta.fill(easy)
    # hand-computed: 12 words, 2 sentences, 12 syllables -> ASL 6, ASW 1: 206.835-6.09-84.6 = 116.145
    eq("grade: hand-computed easy text", got()[:1] + got()[3:], ("116.1", "12", "2", "12"))
    eq("grade: easy text all metrics", got(), readability(easy))
    hard = ("Institutional accountability necessitates comprehensive documentation. Organizations frequently underestimate "
            "the administrative complexity associated with regulatory compliance, which fundamentally complicates "
            "interdepartmental communication! Is simplification realistic?")
    ta.fill(hard)
    eq("grade: hard prose metrics", got(), readability(hard))
    f_easy, f_hard = float(readability(easy)[0]), float(readability(hard)[0])
    check("grade: hard text scores lower ease than easy", f_hard < f_easy - 60)
    ta.fill("   ")
    check("grade: empty -> notice", seen(page, "Enter English prose"))
    no_overflow(page, "grade")


def t_sentences(page):
    open_tab(page, "reading-grade", "sentences")
    long_s = " ".join(["word"] * 30) + "."
    text = f"Short one. {long_s} Is this fine? Yes"
    page.get_by_label("Text").fill(text)
    eq("sentences: count", stat(page, "Sentences"), "4")
    eq("sentences: average", stat(page, "Average words / sentence"), js((2 + 30 + 3 + 1) / 4, 1))
    eq("sentences: over 25", stat(page, "Over 25 words"), "1")
    heads = [norm(x) for x in page.locator("div.mb-1.text-xs").all_inner_texts()]
    eq("sentences: per-sentence rows", heads, ["Sentence 1 · 2 words", "Sentence 2 · 30 words · long", "Sentence 3 · 3 words", "Sentence 4 · 1 word"])  # singular fixed 2026-10-10; the old expectation encoded "1 words"
    # Decimals, versions, times, titles and dated months do not end a sentence (regression, 2026-10-10: this text split into 9).
    page.get_by_label("Text").fill("Dr. Smith paid $3.50 at 5 p.m. on Jan. 5. See v1.2.3 now.")
    eq("sentences: abbreviations/decimals/versions -> 2 sentences", stat(page, "Sentences"), "2")
    page.get_by_label("Text").fill("")
    eq("sentences: empty", stat(page, "Sentences"), "0")
    no_overflow(page, "sentences")


def t_punct(page):
    open_tab(page, "reading-grade", "punctuation")
    page.get_by_label("Text to check").fill("Hello , world.It works!!!!  Really ?\nSecond line is fine.")
    eq("punct: issue count", stat(page, "Potential issues"), "5")
    out = page.get_by_label("Findings").input_value().split("\n")
    eq("punct: findings", sorted(out), sorted([
        "Line 1: Whitespace before punctuation — ·,", "Line 1: Whitespace before punctuation — ·?",
        "Line 1: Repeated spaces — ··", "Line 1: Possible missing space after sentence mark — .",
        "Line 1: Repeated terminal punctuation — !!!!"]))
    page.get_by_role("button", name="Copy findings").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("punct: clipboard == findings", read_clip(page), "\n".join(out))
    page.get_by_label("Text to check").fill("Clean text. Nothing wrong here!")
    check("punct: clean text message", seen(page, "No common spacing issues detected."))
    check("punct: copy disabled when no findings", page.get_by_role("button", name="Copy findings").is_disabled())
    no_overflow(page, "punct")


def t_words(page):
    open_tab(page, "reading-grade", "words")
    ta = page.get_by_label("Text to analyze")
    ta.fill("The Cat and the dog and THE bird")
    rows = [norm(r) for r in page.locator("tbody tr").all_inner_texts()]
    eq("words: by frequency then alpha", rows, ["the 3 37.5%", "and 2 25.0%", "bird 1 12.5%", "cat 1 12.5%", "dog 1 12.5%"])
    eq("words: totals", stat(page, "Words / unique"), "8 / 5")
    page.get_by_label("Sort order").select_option("alpha")
    eq("words: alphabetical", [norm(r).split()[0] for r in page.locator("tbody tr").all_inner_texts()], ["and", "bird", "cat", "dog", "the"])
    fill(page, "Minimum characters", "4")
    eq("words: min length filter", [norm(r) for r in page.locator("tbody tr").all_inner_texts()], ["bird 1 100.0%"])
    fill(page, "Minimum characters", "1")
    page.get_by_role("button", name="Copy TSV").click()
    page.wait_for_function("document.body.innerText.includes('Copied')")
    eq("words: TSV clipboard", read_clip(page), "and\t2\nbird\t1\ncat\t1\ndog\t1\nthe\t3")
    ta.fill("Don’t stop, don’t stop: naïve café 42")
    eq("words: unicode/apostrophes", [norm(r).split()[0] for r in page.locator("tbody tr").all_inner_texts()],
       ["42", "café", "don’t", "naïve", "stop"])
    no_overflow(page, "words")


# ---------------------------------------------------------------------------- meeting-timezones
ZONES_MEET = ["UTC", "Europe/Warsaw", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney"]
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def t_meeting(page):
    open_tab(page, "meeting-timezones", "meeting")
    for d, t in [("2026-10-05", "09:00"), ("2026-03-29", "00:59"), ("2026-03-29", "01:00"), ("2026-11-01", "06:30")]:
        fill(page, "Meeting date (UTC)", d); fill(page, "Meeting time (UTC)", t)
        inst = datetime.fromisoformat(f"{d}T{t}:00").replace(tzinfo=timezone.utc)
        eq(f"meeting {d} {t}Z: shared instant", stat(page, "Shared instant"), "UTC · " + inst.isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        for z in ZONES_MEET:
            loc = inst.astimezone(ZoneInfo(z))
            txt = norm(page.get_by_text(z).locator("xpath=following-sibling::div[1]").inner_text())
            ok = txt.startswith(f"{loc.day} {MON[loc.month - 1]} {loc.year}, {loc:%H:%M}")
            check(f"meeting {d} {t}Z: {z} -> {loc:%d %b %H:%M}", ok, txt)
    fill(page, "Meeting date (UTC)", "")
    eq("meeting: cleared date -> Invalid", stat(page, "Shared instant"), "Invalid")
    no_overflow(page, "meeting")


def overlap_expect(day: date, za: str, zb: str, sa, ea, sb, eb) -> int:
    def inst(z, hm):
        h, m = map(int, hm.split(":"))
        return datetime(day.year, day.month, day.day, h, m, tzinfo=ZoneInfo(z)).astimezone(timezone.utc)
    lo, hi = max(inst(za, sa), inst(zb, sb)), min(inst(za, ea), inst(zb, eb))
    return max(0, int((hi - lo).total_seconds() // 60))


def t_overlap(page):
    open_tab(page, "meeting-timezones", "overlap")
    class _S:
        def __init__(self, k): self.k = k
        def locator(self, _): return page.locator("select").nth(self.k)
        def get_by_label(self, l): return page.get_by_label(l, exact=True).nth(self.k)
    sa, sb = _S(0), _S(1)

    def setup(d, za, zb, a0="09:00", a1="17:00", b0="09:00", b1="17:00"):
        fill(page, "Date for both schedules", d)
        sa.locator("select").select_option(za); sb.locator("select").select_option(zb)
        sa.get_by_label("Start").fill(a0); sa.get_by_label("End").fill(a1)
        sb.get_by_label("Start").fill(b0); sb.get_by_label("End").fill(b1)

    for d, za, zb, a0, a1, b0, b1 in [
        ("2026-10-05", "Europe/Warsaw", "America/New_York", "09:00", "17:00", "09:00", "17:00"),
        ("2026-10-27", "Europe/Warsaw", "America/New_York", "09:00", "17:00", "09:00", "17:00"),   # Warsaw back on CET, NY still EDT
        ("2026-03-10", "Europe/London", "America/Los_Angeles", "08:00", "18:30", "09:00", "17:45"),  # US DST started, UK not
        ("2026-10-05", "Europe/Warsaw", "Australia/Sydney", "07:00", "12:00", "10:00", "20:00"),
    ]:
        setup(d, za, zb, a0, a1, b0, b1)
        mins = overlap_expect(date.fromisoformat(d), za, zb, a0, a1, b0, b1)
        want = f"{mins // 60}h {mins % 60}m"
        eq(f"overlap {d} {za} vs {zb}", stat(page, "Shared business time"), want)
    # ranges rendered in each zone are consistent for the last case
    setup("2026-10-05", "Europe/Warsaw", "America/New_York")
    ra = stat(page, "Europe/Warsaw"); rb = stat(page, "America/New_York")
    check("overlap: ranges 15:00-17:00 Warsaw / 09:00-11:00 NY", "15:00" in ra and "17:00" in ra and "09:00" in rb and "11:00" in rb, f"{ra} | {rb}")
    setup("2026-10-05", "Asia/Tokyo", "America/New_York")
    check("overlap: none -> notice", seen(page, "No overlap on this date."))
    setup("2026-10-05", "Europe/Warsaw", "Europe/London", "17:00", "09:00")
    check("overlap: end<=start error", seen(page, "End time must be after start time"))
    setup("2026-03-29", "Europe/Warsaw", "Europe/London", "02:30", "10:00")
    check("overlap: DST-gap time rejected", seen(page, "does not exist in Europe/Warsaw (DST gap)"))
    no_overflow(page, "overlap")


def transitions(z: str, year: int):
    tz = ZoneInfo(z)
    t = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    prev = t.astimezone(tz).utcoffset()
    out = []
    while t < end:
        t2 = t + timedelta(minutes=15)
        cur = t2.astimezone(tz).utcoffset()
        if cur != prev:
            out.append((t2.strftime("%Y-%m-%dT%H:%M:%S.000Z"), prev, cur))
            prev = cur
        t = t2
    return out


def hrs(td: timedelta) -> str:
    h = td.total_seconds() / 3600
    return ("+" if h >= 0 else "") + f"{h:.2f}h"


def t_dst(page):
    open_tab(page, "meeting-timezones", "dst")
    for z in ["Europe/Warsaw", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "Asia/Tokyo", "UTC"]:
        for y in (2026, 2027):
            page.get_by_label("IANA timezone").select_option(z)
            fill(page, "Year", str(y))
            want = transitions(z, y)
            eq(f"dst {z} {y}: transition count", stat(page, "UTC offset changes"), str(len(want)))
            cards = [norm(c) for c in page.locator("div.rounded-lg.border.p-3.text-sm").all_inner_texts()]
            exp = [f"{iso} UTC offset: {hrs(a)} → {hrs(b)}" for iso, a, b in want]
            eq(f"dst {z} {y}: instants + offsets", cards, exp)
    check("dst: UTC shows no-change message", True)
    fill(page, "Year", "1900")
    eq("dst: year clamped to 1970", page.get_by_label("Year").input_value(), "1970")
    page.get_by_label("IANA timezone").select_option("UTC")
    check("dst: no-change text for UTC", seen(page, "No offset change found in this timezone/year."))
    no_overflow(page, "dst")


def t_workdays(page):
    open_tab(page, "meeting-timezones", "workdays")

    def wd(a: date, b: date, hol: set[date]) -> int:
        n, d = 0, a
        while d <= b:
            if d.weekday() < 5 and d not in hol:
                n += 1
            d += timedelta(days=1)
        return n
    hol_txt = lambda s: page.get_by_label("Holiday dates (one ISO date per line)").fill(s)
    fill(page, "Start date (inclusive)", "2026-10-01"); fill(page, "End date (inclusive)", "2026-10-31")
    hol_txt("2026-10-12")
    eq("workdays: Oct 2026 w/ 1 holiday", stat(page, "Weekdays excluding listed holidays"),
       str(wd(date(2026, 10, 1), date(2026, 10, 31), {date(2026, 10, 12)})))
    hol_txt("2026-10-12\n2026-10-17\nnot-a-date\n2026-10-12\n2026-02-30")
    eq("workdays: weekend/dup/garbage holidays ignored", stat(page, "Weekdays excluding listed holidays"),
       str(wd(date(2026, 10, 1), date(2026, 10, 31), {date(2026, 10, 12)})))
    fill(page, "Start date (inclusive)", "2026-12-24"); fill(page, "End date (inclusive)", "2027-01-06")
    hol_txt("2026-12-25\n2026-12-26\n2027-01-01\n2027-01-06")
    eq("workdays: across year boundary", stat(page, "Weekdays excluding listed holidays"),
       str(wd(date(2026, 12, 24), date(2027, 1, 6), {date(2026, 12, 25), date(2026, 12, 26), date(2027, 1, 1), date(2027, 1, 6)})))
    fill(page, "End date (inclusive)", "2026-12-01")
    check("workdays: end<start error", seen(page, "Choose valid dates with the end on or after the start."))
    fill(page, "End date (inclusive)", "2100-12-31")
    check("workdays: >20000 day limit error", seen(page, "exceeds the 20,000-day"))
    no_overflow(page, "workdays")


# --- cron (browser tz forced to Europe/Warsaw, clock frozen) ---
CRON_NOW = datetime(2026, 10, 4, 10, 7, 30, tzinfo=ZoneInfo("Europe/Warsaw"))


def cron_field_set(raw: str, lo: int, hi: int, dow=False) -> set[int]:
    out: set[int] = set()
    for part in raw.split(","):
        rng, _, step = part.partition("/")
        st = int(step) if step else 1
        if rng == "*":
            a, b = lo, hi
        elif "-" in rng:
            a, b = map(int, rng.split("-"))
        else:
            a = int(rng)
            b = hi if step else a
        out |= {(0 if dow and v == 7 else v) for v in range(a, b + 1, st)}
    return out


def cron_expect(expr: str, n=10):
    f = expr.split()
    mi, ho = cron_field_set(f[0], 0, 59), cron_field_set(f[1], 0, 23)
    dom, mo, dw = cron_field_set(f[2], 1, 31), cron_field_set(f[3], 1, 12), cron_field_set(f[4], 0, 7, True)
    t = CRON_NOW.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    stop = t + timedelta(days=366)
    res = []
    tz = ZoneInfo("Europe/Warsaw")
    while t <= stop and len(res) < n:
        L = t.astimezone(tz)
        dm, dwm = L.day in dom, ((L.isoweekday() % 7) in dw)
        if f[2] == "*" and f[4] == "*":
            day_ok = True
        elif f[2] == "*":
            day_ok = dwm
        elif f[4] == "*":
            day_ok = dm
        else:
            day_ok = dm or dwm
        if L.minute in mi and L.hour in ho and L.month in mo and day_ok:
            res.append(L.strftime("%Y-%m-%d %H:%M"))
        t += timedelta(minutes=1)
    return res


def parse_cron_dt(text: str) -> str:
    m = re.search(r"(\w{3}) (\d+), (\d{4}),? (\d{1,2}):(\d{2}) (AM|PM)", text)
    if not m:
        return f"UNPARSED[{text}]"
    mon, d, y, h, mi, ap = m.groups()
    h = int(h) % 12 + (12 if ap == "PM" else 0)
    return f"{y}-{MON.index(mon) + 1:02d}-{int(d):02d} {h:02d}:{mi}"


def t_cron(ctx):
    page = ctx.new_page()
    watch(page)
    page.clock.set_fixed_time(CRON_NOW)
    open_tab(page, "meeting-timezones", "cron")
    inp = page.get_by_label("Five-field schedule")
    btn = page.get_by_role("button", name="Preview next 10 runs")

    def run(expr):
        inp.fill(expr); btn.click()
        page.wait_for_function("document.querySelector('ol li time')||document.body.innerText.includes('No matching run')")
        return [parse_cron_dt(x) for x in page.locator("ol li time").all_inner_texts()]
    for expr in ["*/15 * * * *", "*/5 9-17 * * 1-5", "0 9 1 * *", "30 8 13 * 5", "0 0 * * 7", "15,45 6-8/2 * 1-3,10 *", "0 12 * * 0,6", "5/20 22 * * *"]:
        eq(f"cron '{expr}': next 10 runs", run(expr), cron_expect(expr))
    eq("cron: all 10 rows shown, zone label", (page.locator("ol li").count(), "Europe/Warsaw" in page.locator("body").inner_text()), (10, True))
    inp.fill("0 12 29 2 *"); btn.click()
    check("cron 0 12 29 2 * (leap day beyond 1y): no-run notice", seen(page, "No matching run was found in the next year."))
    page.get_by_role("button", name="Midnight daily").click()
    eq("cron: preset fills input", inp.input_value(), "0 0 * * *")
    eq("cron: field breakdown", [stat(page, l) for l in ["Minute", "Hour", "Day of month", "Month", "Day of week"]], ["0", "0", "*", "*", "*"])
    check("cron: edit hides stale preview", page.locator("ol li").count() == 0)
    for expr, msg in [("61 * * * *", "minute values must be between 0 and 59"), ("* * * *", "Use five fields"),
                      ("*/0 * * * *", "step must be at least 1"), ("0 0 * * mon", "Invalid day of week range"),
                      ("30-10 * * * *", "range must go from low to high"), ("0 24 * * *", "hour values must be between 0 and 23")]:
        inp.fill(expr)
        check(f"cron invalid '{expr}': error + disabled", msg in page.locator("body").inner_text() and btn.is_disabled(), expr)
    no_overflow(page, "cron")
    page.close()


def rr_expect(rule: dict, start: date, **kw) -> list[str]:
    return [d.date().isoformat() for d in rrule.rrule(dtstart=datetime(start.year, start.month, start.day), **kw)]


def t_rrule(page):
    open_tab(page, "meeting-timezones", "recurrence")
    rule = page.get_by_label("RRULE")
    out = page.get_by_label("Upcoming UTC occurrences")
    s = date(2026, 10, 1)
    fill(page, "Start date (UTC)", "2026-10-01")
    MO, TU, WE, TH, FR = rrule.MO, rrule.TU, rrule.WE, rrule.TH, rrule.FR
    cases = [
        ("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;COUNT=8", dict(freq=rrule.WEEKLY, byweekday=(MO, WE, FR), count=8)),
        ("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=6", dict(freq=rrule.WEEKLY, interval=2, byweekday=(MO, FR), count=6)),
        ("FREQ=WEEKLY;INTERVAL=2;COUNT=4", dict(freq=rrule.WEEKLY, interval=2, count=4)),
        ("RRULE:FREQ=YEARLY;COUNT=3", dict(freq=rrule.YEARLY, count=3)),
        ("FREQ=MONTHLY;COUNT=14", dict(freq=rrule.MONTHLY, count=14)),
        ("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6", dict(freq=rrule.MONTHLY, bymonthday=-1, count=6)),
        ("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4", dict(freq=rrule.MONTHLY, bymonthday=31, count=4)),
        ("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1,15;COUNT=6", dict(freq=rrule.MONTHLY, interval=2, bymonthday=(1, 15), count=6)),
        ("FREQ=DAILY;INTERVAL=3;UNTIL=20261031T000000Z", dict(freq=rrule.DAILY, interval=3, until=datetime(2026, 10, 31))),
        ("FREQ=DAILY;UNTIL=20261010", dict(freq=rrule.DAILY, until=datetime(2026, 10, 10))),
        ("FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261101", dict(freq=rrule.WEEKLY, byweekday=(TU, TH), until=datetime(2026, 11, 1))),
    ]
    for text, kw in cases:
        rule.fill(text)
        got = out.input_value().split("\n")
        eq(f"rrule '{text}'", got, rr_expect({}, s, **kw))
    rule.fill("FREQ=WEEKLY;BYDAY=MO;COUNT=3")
    eq("rrule: summary stats", (stat(page, "Frequency"), stat(page, "Interval"), stat(page, "COUNT limit")), ("WEEKLY", "1", "3"))
    for bad, msg in [("FREQ=HOURLY", "FREQ must be DAILY, WEEKLY, MONTHLY, or YEARLY."), ("FREQ=DAILY;INTERVAL=0", "INTERVAL must be 1–365."),
                     ("FREQ=WEEKLY;BYDAY=1MO", "Unsupported BYDAY value: 1MO"), ("garbage", "Invalid rule field: garbage"),
                     ("FREQ=DAILY;COUNT=0", "COUNT must be 1–10000."), ("FREQ=MONTHLY;BYMONTHDAY=0", "BYMONTHDAY accepts values")]:
        rule.fill(bad)
        check(f"rrule invalid '{bad}'", msg in page.locator("body").inner_text(), page.locator("body").inner_text()[:200])
    no_overflow(page, "rrule")


# ---------------------------------------------------------------------------- driver
def watch(page) -> None:
    page.on("console", lambda m: ERRORS.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: ERRORS.append(f"pageerror: {e}"))


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", args=[f"--unsafely-treat-insecure-origin-as-secure={BASE}"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 900}, timezone_id="Europe/Warsaw", locale="en-US")
        ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=BASE)
        page = ctx.new_page()
        watch(page)
        page.set_default_timeout(8000)
        steps = [t_shadow, t_radius, t_easing, t_grid, t_clamp, t_typescale, t_resolver, t_tokens, t_headings, t_links, t_forms,
                 t_landmarks, t_grade, t_sentences, t_punct, t_words, t_meeting, t_overlap, t_dst, t_workdays, t_rrule]
        for step in steps:
            try:
                step(page)
            except Exception as e:  # noqa: BLE001
                check(f"{step.__name__} ran to completion", False, repr(e)[:400])
        try:
            t_cron(ctx)
        except Exception as e:  # noqa: BLE001
            check("t_cron ran to completion", False, repr(e)[:400])
        # filter dev-server noise unrelated to the app (HMR websocket etc.)
        errs = [e for e in ERRORS if "favicon" not in e]
        check("zero console/page errors", not errs, "\n     " + "\n     ".join(errs[:8]))
        browser.close()
    print(f"\n{'ALL PASS' if not FAILS else 'FAILED: ' + str(len(FAILS))}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
