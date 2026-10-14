"""Real-agent coverage for CV Studio's five user-facing lanes.

All inputs are self-contained and use distinct sentinel values so an oracle cannot
pass by echoing the prompt. Cases intentionally mutate only the scratch account.
"""

from pathlib import Path

from tests.coverage.core import Case, Ctx, first_error, has, matches

REPO_ROOT = Path(__file__).resolve().parents[3]

GROUP = "cv"
SKIPS: dict[tuple[str, str | None], str] = {}


def _cv(c: Ctx) -> dict:
    """The account's persisted CV data (GET /api/cv): what was really saved, independent of which route the agent took
    (knife_cv_* tools write the store without touching the page, so page text is not evidence)."""
    return c.page.evaluate("fetch('/api/cv').then(r => r.json())")


def _norm(v: object) -> str:
    return " ".join(str(v).split()).casefold()


_PROFILE_EN = "Reduced cold-start latency by 37% across 14 services."
_PROFILE_PL = "Obniżono opóźnienie zimnego startu o 37% w 14 usługach."


def _profile(c: Ctx):
    summary = _cv(c).get("profile", {}).get("summary", {})
    return first_error(
        None if summary.get("en") == _PROFILE_EN else f"stored English summary is {summary.get('en')!r}",
        None if summary.get("pl") == _PROFILE_PL else f"stored Polish summary is {summary.get('pl')!r}",
        has(c.answer, "37%", "14"),
    )


_JOB_COMPANY = "Coverage Observatory"
_JOB_TITLE = "Senior Data Reliability Engineer"
_JOB_TEXT = """Coverage Observatory is hiring a Senior Data Reliability Engineer in Gdansk.
Required: PostgreSQL query tuning and Python data pipelines.
Nice to have: Apache Iceberg.
The role owns data quality alerts for 12 production datasets."""


def _jobs(c: Ctx):
    jobs = [j for j in _cv(c).get("jobs", []) if _norm(j.get("company")) == _norm(_JOB_COMPANY) and _norm(j.get("title")) == _norm(_JOB_TITLE)]
    if not jobs:
        return "no stored job offer with the right company and title"
    good = [j for j in jobs
            if any("postgresql query tuning" in _norm(r) for r in j.get("requirements", []))
            and any("python data pipelines" in _norm(r) for r in j.get("requirements", []))
            and any("apache iceberg" in _norm(r) for r in j.get("niceToHave", []))
            and "12 production datasets" in _norm(j.get("text", ""))]
    return first_error(
        None if good else "stored offer lacks the requirements / nice-to-have / posting text",
        has(c.answer, _JOB_COMPANY, _JOB_TITLE, "PostgreSQL"),
        matches(c.answer, r"saved|added|created|stored"),
    )


_VARIANT_NAME = "Coverage Variant 731"


_VARIANT_SUMMARY = "Platform engineer focused on dependable queues and observable services."


def _variants(c: Ctx):
    vs = [v for v in _cv(c).get("variants", []) if _norm(v.get("name")) == _norm(_VARIANT_NAME)]
    if not vs:
        return "no stored CV version with that name"
    v = vs[0]
    return first_error(
        None if v.get("lang") == "en" else f"version language is {v.get('lang')!r}",
        None if _norm(v.get("target")) == _norm("Platform Reliability Engineer") else f"target role is {v.get('target')!r}",
        None if (v.get("summary") or {}).get("en") == _VARIANT_SUMMARY else "summary override is not the verbatim text",
        None if not v.get("experience") else "version lists work history (none exists in the profile)",
        has(c.answer, _VARIANT_NAME, "Platform Reliability Engineer"),
    )


_APP_COMPANY = "Northstar Coverage Labs"
_APP_ROLE = "Principal Queue Engineer"


def _applications(c: Ctx):
    apps = [a for a in _cv(c).get("applications", []) if _norm(a.get("company")) == _norm(_APP_COMPANY) and _norm(a.get("role")) == _norm(_APP_ROLE)]
    if not apps:
        return "no tracked application with that company and role"
    a = apps[0]
    return first_error(
        None if a.get("status") == "screening" else f"stored status is {a.get('status')!r}",
        None if _norm(a.get("nextAction")) == _norm("Prepare architecture interview") else f"next action is {a.get('nextAction')!r}",
        None if a.get("nextActionDue") == "2099-04-17" else f"due date is {a.get('nextActionDue')!r}",
        has(c.answer, _APP_COMPANY, _APP_ROLE),
        matches(c.answer, r"screening"),
    )


def _showcase(c: Ctx):
    h = c.haystack()
    return first_error(
        has(h, "Samurai-Knife"),
        matches(c.answer, r"(?:score|checklist|README|tests|TypeScript)"),
    )


CASES = [
    Case(
        "cv-studio",
        "profile",
        "Add this exact English and Polish achievement to my CV summary, preserving the number and percentage exactly. "
        f"English: “{_PROFILE_EN}” Polish: “{_PROFILE_PL}” Save it and tell me what you added.",
        _profile,
    ),
    Case(
        "cv-studio",
        "jobs",
        "Save this job posting so I can tailor my CV to it. The company is Coverage Observatory and the title is "
        "Senior Data Reliability Engineer. Keep the requirements PostgreSQL query tuning and Python data pipelines, "
        "and the nice-to-have Apache Iceberg. Tell me the company, title, and requirements you stored.\n\n" + _JOB_TEXT,
        _jobs,
    ),
    Case(
        "cv-studio",
        "variants",
        "Create a saved English CV version named Coverage Variant 731 for a Platform Reliability Engineer role. "
        "Use this summary override verbatim: “Platform engineer focused on dependable queues and observable services.” "
        "Do not invent work history; save the version and tell me its name and target role.",
        _variants,
    ),
    Case(
        "cv-studio",
        "applications",
        "Track an application to Northstar Coverage Labs for Principal Queue Engineer, currently at the screening stage. "
        "Set the next action to “Prepare architecture interview” and its due date to 2099-04-17. Save it and tell me the company, role, and status.",
        _applications,
    ),
    Case(
        "cv-studio",
        "showcase",
        f"Inspect the local repository at {REPO_ROOT} as evidence for my CV project showcase. "
        "Report its actual repository name and one verifiable fact from its README, tests, or language breakdown; do not invent facts.",
        _showcase,
    ),
]
