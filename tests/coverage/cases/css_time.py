"""css_time group: box-shadow, css-grid (clamp, type scale) and the dates suite (meeting planner, workdays, recurrence, cron)."""
import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from tests.coverage.core import Case, Ctx, first_error, matches

GROUP = "css_time"
SKIPS: dict[tuple[str, str | None], str] = {}

_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def date_re(d: date) -> str:
    """Regex for one calendar date in ISO / '5 Oct' / 'October 5' styles."""
    m = _MONTHS[d.month - 1][:3]
    return (rf"{d.isoformat()}|(?<!\d){d.day}(?:st|nd|rd|th)?\s+(?:of\s+)?{m}[a-z]*\.?(?![a-z])"
            rf"|{m}[a-z]*\.?\s+{d.day}(?:st|nd|rd|th)?(?!\d)")


def has_date(hay: str, d: date) -> str | None:
    return None if re.search(date_re(d), hay, re.I) else f"date {d.isoformat()} not found"


def clock_re(h: int, m: int) -> str:
    h12 = h % 12 or 12
    return rf"(?<![\d:])0?{h}:{m:02d}(?!\d)|(?<!\d){h12}:{m:02d}\s*[ap]\.?m"


def num(hay: str, n: int | str) -> bool:
    return bool(re.search(rf"(?<![\d.\-]){n}(?![\d\-]|\.\d)", hay))


def count_is(hay: str, n: int, word: str) -> bool:
    return num(hay, n) or bool(re.search(rf"\b{word}\b", hay, re.I))


# ---------------------------------------------------------------- box-shadow
_SH_RGB = (0x2a, 0x7f, 0x62)  # #2a7f62


def o_shadow(c: Ctx):
    h = c.haystack()
    r, g, b = _SH_RGB
    color = rf"rgba?\(\s*{r}\s*,\s*{g}\s*,\s*{b}\s*,\s*0?\.350*\s*\)|rgba?\(\s*{r}\s+{g}\s+{b}\s*/\s*(?:35%|0?\.350*)\s*\)"
    return first_error(
        matches(h, rf"inset\s+7px\s+-9px\s+13px\s+3px\s+(?:{color})|7px\s+-9px\s+13px\s+3px\s+(?:{color})\s+inset|inset\s+(?:{color})\s+7px\s+-9px\s+13px\s+3px"),
    )


# ---------------------------------------------------------------- css-grid clamp
def _clamp_expect(mn, mx, w0, w1):
    slope = (mx - mn) / (w1 - w0) * 100
    return mn - slope * w0 / 100, slope


def o_clamp(c: Ctx):
    """clamp(min, <intercept>px + <slope>vw, max), tolerant of: calc() around the middle term, either term order, extra digits."""
    inter, slope = _clamp_expect(14, 29, 375, 1440)
    num_ = r"(-?\d*\.?\d+)"
    mid_a = rf"(?:calc\(\s*)?{num_}px\s*\+\s*{num_}vw(?:\s*\))?"   # 8.72px + 1.408vw
    mid_b = rf"(?:calc\(\s*)?{num_}vw\s*\+\s*{num_}px(?:\s*\))?"   # 1.408vw + 8.72px
    for m in re.finditer(rf"clamp\(\s*{num_}px\s*,\s*(?:{mid_a}|{mid_b})\s*,\s*{num_}px\s*\)", c.haystack()):
        g = m.groups()
        lo, hi = float(g[0]), float(g[-1])
        b, s_ = (float(g[1]), float(g[2])) if g[1] is not None else (float(g[4]), float(g[3]))
        if lo == 14 and hi == 29 and abs(b - inter) <= 0.02 and abs(s_ - slope) <= 0.002:
            return None
    return f"no clamp(14px, ~{inter:.2f}px + ~{slope:.3f}vw, 29px) found"


def o_typescale(c: Ctx):
    h = c.haystack()
    found = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)\s*px", h)]
    missing = [f"{17 * 1.3 ** i:.2f}" for i in range(-2, 6)
               if not any(abs(f - 17 * 1.3 ** i) <= 0.051 for f in found)]
    return f"missing sizes: {missing}" if missing else None


# ---------------------------------------------------------------- reading-grade
_SENT = ["Rain fell on the town.",
         "The committee reviewed every proposal submitted during the long spring session, carefully weighing costs against benefits, "
         "and then decided that the remaining budget should fund the community library renovation project.",
         "Did the rain ever stop?",
         "Nobody could say for sure, not yet."]
_SENT_WORDS = [len(re.findall(r"[A-Za-z]+", s)) for s in _SENT]
_SENT_AVG = sum(_SENT_WORDS) / len(_SENT_WORDS)


def o_sentences(c: Ctx):
    h = c.haystack()
    avg1 = f"{_SENT_AVG:.1f}"
    avg_ok = num(h, avg1) or num(h, f"{_SENT_AVG:g}") or num(h, f"{_SENT_AVG + 0.05:.1f}")
    long_n = _SENT_WORDS[1]
    return first_error(
        None if avg_ok else f"average {_SENT_AVG} not stated",
        None if num(h, long_n) else f"long sentence word count {long_n} not stated",
        matches(c.answer, r"\b(1|one|single)\b"),
    )


# Four named kinds only (the comma without a following space is deliberately NOT one of them, so the count is unambiguous):
# whitespace before , . ! ? ; : -> " ," and " ?" = 2; repeated spaces = 1 ("!!!  N"); a . ! ? glued to the next letter = 1 ("left.The");
# a run of 3+ ! or ? = 1 ("!!!"). Total 5.
_PUNCT_N = 5


def o_punct(c: Ctx):
    a = c.answer
    return first_error(
        None if re.search(rf"(?<![\d.])(?:{_PUNCT_N}|five)(?![\d.])", a, re.I) else f"answer does not give the count {_PUNCT_N}",
        matches(a, r"repeated[^.\n]{0,40}(punctuation|!|exclamation)|!!!|three exclamation|multiple exclamation|exclamation marks? in a row|run of"),
        matches(a, r"missing space|no space|without a space|glued|stuck to|run together|jammed|joined|next (?:letter|word)|\.T|left\.The|space after (?:the |a )?(?:period|full stop|sentence)"),
        matches(a, r"double space|repeated space|extra space|two spaces|multiple spaces|\"  \"|··|2 spaces"),
        matches(a, r"space[\s-]+before|whitespace[\s-]+before|preceding[\s-]+space|leading[\s-]+space|before the (?:comma|question)|detached"),
    )


def o_words(c: Ctx):
    h = c.haystack()
    return first_error(
        matches(h, r"rain[^\n]{0,40}\b3\b|\b3\b[^\n]{0,40}rain"),
        None if num(h, 16) else "total word count 16 missing",
        None if num(h, 13) else "unique word count 13 missing",
    )


# ---------------------------------------------------------------- heading-audit


def o_headings(c: Ctx):
    h = c.haystack()
    return first_error(
        matches(h, r"h2\W{1,25}(to|→|->|and|then)?\W{0,6}h4"),
        matches(h, r"(more than one|multiple|two|2|duplicate|extra)[^.\n]{0,25}h1|h1[^.\n]{0,50}(twice|two|multiple|more than one|2 )"),
        matches(h, r"enterprise"),
    )


def o_links(c: Ctx):
    h = c.haystack()
    return first_error(
        None if count_is(h, 4, "four") else "4 issues not stated",
        None if count_is(h, 7, "seven") else "7 links not stated",
        matches(h, r"/void|empty|no (accessible )?(link )?(name|text)"),
    )


def o_forms(c: Ctx):
    h = c.haystack()
    return first_error(
        None if count_is(h, 3, "three") else "3 unlabeled not stated",
        None if count_is(h, 7, "seven") else "7 controls not stated",
        matches(h, r"phone|tel"),
        matches(h, r"\bage\b|number"),
        matches(h, r"#co\b|select|country"),
    )


def o_landmarks(c: Ctx):
    h = c.haystack()
    return first_error(
        matches(h, r"nav\w*\W{0,25}\b3\b|\b3\b\W{0,15}nav\w*|three\W{0,10}nav"),
        matches(h, r"(aside|complementary)\W{0,25}\b2\b|\b2\b\W{0,15}(aside|complementary)|two\W{0,10}(aside|complementary)"),
        matches(h, r"exactly one main|one main|single main|main\W{0,25}\b1\b|1 main"),
    )


# ---------------------------------------------------------------- css-var-resolver


def o_vars(c: Ctx):
    return matches(c.haystack(), r"calc\(\s*6px\s*\*\s*3\s*\)\s+6px|\b18px\s+6px")


def o_tokens(c: Ctx):
    h = c.haystack()
    return first_error(
        matches(h, r"duplicate|declared twice|twice|redefin|more than once"),
        matches(h, r"--radius"),
        matches(h, r"undefined|not defined|missing|never defined"),
        matches(h, r"--shadow-soft"),
        matches(h, r"empty"),
        matches(h, r"color\W{1,20}(not|isn|is not|non|isn't)|not a (--)?(custom|token)|non-token|not a custom"),
    )


# ---------------------------------------------------------------- meeting-timezones
_INSTANT = datetime(2026, 11, 3, 13, 15, tzinfo=timezone.utc)


def o_meeting(c: Ctx):
    h = c.haystack()
    errs = []
    for zone, name in [("Asia/Tokyo", "Tokyo"), ("America/New_York", "New York"), ("America/Los_Angeles", "Los Angeles"), ("Australia/Sydney", "Sydney")]:
        loc = _INSTANT.astimezone(ZoneInfo(zone))
        if not re.search(clock_re(loc.hour, loc.minute), h, re.I):
            errs.append(f"{name} {loc:%H:%M}")
    return None if not errs else f"missing local times: {errs}"


def _overlap_minutes(day: date, za: str, zb: str, a, b) -> int:
    def inst(z, hm):
        return datetime(day.year, day.month, day.day, hm[0], hm[1], tzinfo=ZoneInfo(z)).astimezone(timezone.utc)
    lo, hi = max(inst(za, a[0]), inst(zb, b[0])), min(inst(za, a[1]), inst(zb, b[1]))
    return max(0, int((hi - lo).total_seconds() // 60))


_OV_MIN = _overlap_minutes(date(2026, 3, 10), "Europe/London", "America/Los_Angeles", ((8, 30), (16, 30)), ((7, 0), (15, 0)))


def o_overlap(c: Ctx):
    h, m = divmod(_OV_MIN, 60)
    pat = (rf"\b{h}\s*h(?:ours?|rs?)?\s*(?:and\s*)?{m}\s*m|\b{h}\s+hours?\s+(?:and\s+)?{m}\s+min|\b{h}\.5\s*h|\b{_OV_MIN}\s*min")
    return matches(c.haystack(), pat)


def _transitions(zone: str, year: int) -> list[tuple[date, int]]:
    tz = ZoneInfo(zone)
    t = datetime(year, 1, 1, tzinfo=timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    prev = t.astimezone(tz).utcoffset()
    out = []
    while t < end:
        t += timedelta(minutes=15)
        cur = t.astimezone(tz).utcoffset()
        if cur != prev:
            out.append((t.astimezone(tz).date(), int((cur - prev).total_seconds() // 60)))
            prev = cur
    return out


_DST = _transitions("Europe/Warsaw", 2027)


def o_dst(c: Ctx):
    h = c.haystack()
    return first_error(*[has_date(h, d) for d, _ in _DST])


_WD_START, _WD_END = date(2026, 12, 21), date(2027, 1, 8)
_WD_HOL = {date(2026, 12, 25), date(2026, 12, 26), date(2027, 1, 1), date(2027, 1, 6)}
_WD_N = sum(1 for i in range((_WD_END - _WD_START).days + 1)
            if (d := _WD_START + timedelta(days=i)).weekday() < 5 and d not in _WD_HOL)


def o_workdays(c: Ctx):
    return None if num(c.answer, _WD_N) or re.search(rf"Weekdays excluding listed holidays\s*{_WD_N}\b", c.page_only()) else f"workday count {_WD_N} not stated"


def _rrule_dates() -> list[date]:
    start, out, d = date(2026, 10, 5), [], date(2026, 10, 5)
    while len(out) < 6:
        weeks = ((d - timedelta(days=d.weekday())) - (start - timedelta(days=start.weekday()))).days // 7
        if weeks % 2 == 0 and d.weekday() in (0, 4):
            out.append(d)
        d += timedelta(days=1)
    return out


_RR = _rrule_dates()


def o_recurrence(c: Ctx):
    h = c.haystack()
    return first_error(*[has_date(h, d) for d in _RR])


# ---------------------------------------------------------------- css playground (runs the code in its preview)
_PG_TS = "const xs: number[] = [3, 9, 27];\nconsole.log(\"total\", xs.reduce((a, b) => a + b, 0) * 7);"


def _playground(c: Ctx):
    # 273 must come from the preview's console on the page (the code really ran as TypeScript), and reach the answer.
    return first_error(
        None if "/tools/css" in c.url() else f"not in the CSS workbench (url {c.url()})",
        matches(c.page_only(), r"total\s*273\b"),
        matches(c.answer, r"\b273\b"),
    )


CASES = [
    Case("dates", "cron",
         "When does the cron schedule `30 9 * * 1-5` run? Explain it in plain English.",
         lambda c: first_error(matches(c.haystack(), r"9:30|09:30"), matches(c.haystack(), r"weekday|monday"))),

    Case("css", "shadow",
         "I need the CSS for a card shadow: an inset shadow shifted 7px to the right and 9px up, 13px blur, 3px spread, "
         "in colour #2a7f62 at 35% opacity. Give me the exact box-shadow declaration.",
         o_shadow),
    Case("css", "radius",
         "Give me the CSS border-radius for a blob shape with elliptical corners, in percentages. Horizontal radii: top-left 12, "
         "top-right 34, bottom-right 56, bottom-left 78. Vertical radii in the same order: 15, 25, 45, 65.",
         lambda c: matches(c.haystack(), r"12%\s+34%\s+56%\s+78%\s*/\s*15%\s+25%\s+45%\s+65%")),
    Case("css", "easing",
         "Build me a CSS cubic-bezier easing curve whose first control point is at (0.34, -0.45) and second control point at (0.28, 1.35), "
         "and give me the transition-timing-function line.",
         lambda c: matches(c.haystack(), r"cubic-bezier\(\s*0?\.34\s*,\s*-0?\.45\s*,\s*0?\.28\s*,\s*1\.35\s*\)")),

    Case("css", "grid",
         "Make me a CSS grid layout with 5 equal-width columns, 4 rows, an 18px gap and 11 items. I want the grid CSS.",
         lambda c: matches(c.haystack(), r"repeat\(\s*5\s*,.*repeat\(\s*4\s*,.*gap:\s*18px")),
    Case("css", "clamp",
         "I want fluid typography: font-size that scales smoothly from 14px when the viewport is 375px wide up to 29px at a 1440px "
         "viewport, as a CSS clamp() expression in px and vw.",
         o_clamp),
    Case("css", "type-scale",
         "Generate a modular type scale for my design system: base size 17px, ratio 1.3, from two steps below the base up to five steps above. "
         "Give me every size in px (as CSS custom properties) and state them in your answer.",
         o_typescale),


    Case("dates", "meeting",
         "A call is fixed for 3 November 2026 at 13:15 UTC. What local time and date is that in Tokyo, New York, Los Angeles and Sydney?",
         o_meeting),
    Case("dates", "workdays",
         "How many working days (Monday to Friday) are there from 21 December 2026 to 8 January 2027, both days included, if these "
         "public holidays are not working days: 25 December 2026, 26 December 2026, 1 January 2027 and 6 January 2027?",
         o_workdays),
    Case("dates", "recurrence",
         "A meeting starts on Monday 5 October 2026 and repeats every 2 weeks on Mondays and Fridays (RFC 5545 style rule, weeks start "
         "on Monday), 6 occurrences in total, the first being the start day. List the dates of all occurrences.",
         o_recurrence),
    Case("css", "playground",
         "In the CSS playground, switch the script to TypeScript and make it exactly this code:\n\n" + _PG_TS
         + "\n\nRun it in the preview and tell me what the preview's console printed.", _playground),
]
