#!/usr/bin/env python3
"""Every CV layout exported as PDF and DOCX in Polish and English, from the real CV studio preview on a scratch server.

For each layout x language: the PDF (WeasyPrint) has 1-3 pages, carries the name and a bullet as text, has link
annotations for the e-mail, phone and every profile link, and uses the bundled fonts; the DOCX opens, carries the name
and real hyperlinks (w:hyperlink + external relationships). The HTML export is one self-contained file and the TXT
export is the ATS text. Also: the project-pages modes, Letter paper, full-URL links, and a refused foreign sheet.
Then every PDF's first page is rendered to PNG (pdftoppm) and tiled into a contact sheet to look at
($CV_SHEET, default /tmp/cv-layouts/contact-sheet.png).

Needs the Python lane venv (KNIFE_PYTHON or ../samurai-knife-py/venv) with weasyprint, pypdf, python-docx.
Usage: python3 tests/cv_layouts_export_e2e.py [--only ats,modern] [--keep]
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import sync_playwright  # noqa: E402

from tests.scratch_server import ScratchServer  # noqa: E402

PY = os.environ.get("KNIFE_PYTHON") or str(ROOT.parent / "samurai-knife-py" / "venv" / "bin" / "python")
OUT = Path(os.environ.get("CV_SHEET_DIR", "/tmp/cv-layouts"))
LAYOUTS = ["ats", "compact", "minimal", "classic", "modern", "elegant", "executive", "technical", "timeline", "banner", "sidebar", "rightbar", "creative", "europass"]
PROFILE = json.loads((ROOT / "tests" / "fixtures" / "cv_sample_profile.json").read_text())
FAILS: list[str] = []
PASSES = 0


def check(name: str, ok: bool, detail: object = "") -> bool:
    global PASSES
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'' if ok else '  -> ' + str(detail)[:400]}", flush=True)
    if ok:
        PASSES += 1
    else:
        FAILS.append(name)
    return ok


def inspect_pdf(data: bytes) -> dict:
    code = r"""
import io, json, sys
from pypdf import PdfReader
r = PdfReader(io.BytesIO(sys.stdin.buffer.read()))
links, fonts, text = [], set(), []
for p in r.pages:
    text.append(p.extract_text() or "")
    for a in p.get("/Annots", []) or []:
        a = a.get_object()
        uri = (a.get("/A") or {}).get("/URI")
        if uri: links.append(str(uri))
    res = p.get("/Resources") or {}
    for f in (res.get("/Font") or {}).values():
        fonts.add(str(f.get_object().get("/BaseFont")))
print(json.dumps({"pages": len(r.pages), "links": links, "fonts": sorted(fonts), "text": "\n".join(text)}))
"""
    done = subprocess.run([PY, "-I", "-c", code], input=data, capture_output=True, check=True)
    return json.loads(done.stdout)


def inspect_docx(data: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        body = z.read("word/document.xml").decode()
        rels = z.read("word/_rels/document.xml.rels").decode()
    import re
    targets = re.findall(r'Target="([^"]+)" TargetMode="External"', rels)
    return {"hyperlinks": body.count("<w:hyperlink"), "targets": targets, "xml": body}


def main() -> int:
    only = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), "")
    layouts = [x for x in LAYOUTS if not only or x in only.split(",")]
    OUT.mkdir(parents=True, exist_ok=True)
    untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True).stdout.split()
    overlay = [u for u in untracked if u.startswith(("src/", "tests/", "public/", "server/"))]
    shots: list[tuple[str, Path]] = []
    with ScratchServer() as server:
        base = server.start(env={"KNIFE_PYTHON": PY}, overlay=overlay)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(base_url=base, viewport={"width": 1440, "height": 1000}, accept_downloads=True)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("console", lambda m: errors.append(m.text[:200]) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.goto("/tools/cv-studio?tab=profile", wait_until="networkidle")
            status = page.evaluate("p => fetch('/api/cv/import', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({profile: p, overwrite: true})}).then(r => r.status)", PROFILE)
            check("profile imported", status == 200, status)

            def export(fmt: str, lang: str, layout: str, extra: dict | None = None) -> tuple[int, bytes, dict]:
                result = page.evaluate(
                    """async ([fmt, lang, layout, extra]) => {
                        const sheet = document.querySelector('[data-cv-document]');
                        const body = { variantId: null, lang, theme: layout, photo: false, format: fmt, ...extra, sheet: sheet ? sheet.outerHTML : undefined };
                        const r = await fetch('/api/cv/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
                        const buf = new Uint8Array(await r.arrayBuffer());
                        let s = ''; for (const b of buf) s += String.fromCharCode(b);
                        return { status: r.status, b64: btoa(s), pages: r.headers.get('x-cv-pages') };
                    }""",
                    [fmt, lang, layout, extra or {}],
                )
                import base64
                return result["status"], base64.b64decode(result["b64"]), result

            for lang in ("pl", "en"):
                for layout in layouts:
                    prefs = {f"theme:variants": layout, f"lang:variants": lang, "pages:variants": "cv"}
                    page.evaluate("([k, v]) => localStorage.setItem(k, JSON.stringify(v))", ["samurai-knife:cv-studio:v1", prefs])
                    page.goto("/tools/cv-studio?tab=variants", wait_until="networkidle")
                    page.wait_for_selector(f"[data-cv-document][data-theme={layout}][data-lang={lang}]", timeout=30_000)
                    status, pdf, meta = export("pdf", lang, layout)
                    if not check(f"{layout}/{lang}: PDF built", status == 200 and pdf[:4] == b"%PDF", (status, pdf[:300])):
                        continue
                    info = inspect_pdf(pdf)
                    name = PROFILE["contact"]["name"]
                    bullet = PROFILE["experience"][0]["bullets"][1]["text"][lang]
                    # Compare without case (Classic prints the name in capitals) and without line-break hyphens.
                    flat = " ".join(info["text"].replace("-\n", "-").split())
                    low = flat.lower().replace("- ", "-")
                    check(f"{layout}/{lang}: 1-3 pages ({info['pages']})", 1 <= info["pages"] <= 3, info["pages"])
                    check(f"{layout}/{lang}: name and a bullet as text", name.split()[0].lower() in low and " ".join(bullet.split()[:4]).lower() in low, flat[:300])
                    want = {"mailto:ola.example@example.org", "tel:+48600100200", "https://www.linkedin.com/in/ola-example", "https://github.com/ola-example", "https://ola.example.org", "https://github.com/ola-example/queuectl"}
                    check(f"{layout}/{lang}: links are annotations", want <= set(info["links"]), sorted(set(want) - set(info["links"])))
                    check(f"{layout}/{lang}: bundled fonts embedded", any(f for f in info["fonts"] if any(k in f for k in ("CVInter", "CV-Inter", "CVSerif", "CV-Serif", "CVGeist", "CV-Geist", "Inter", "Source", "Geist"))), info["fonts"])
                    pdf_path = OUT / f"{layout}-{lang}.pdf"
                    pdf_path.write_bytes(pdf)
                    png = OUT / f"{layout}-{lang}"
                    subprocess.run(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", str(pdf_path), str(png)], check=True)
                    shots.append((f"{layout} {lang}", next(OUT.glob(f"{layout}-{lang}*.png"))))
                    status, docx, _ = export("docx", lang, layout)
                    if check(f"{layout}/{lang}: DOCX built", status == 200 and docx[:2] == b"PK", status):
                        d = inspect_docx(docx)
                        check(f"{layout}/{lang}: DOCX has real hyperlinks", d["hyperlinks"] >= 5 and "https://github.com/ola-example" in d["targets"] and "mailto:ola.example@example.org" in d["targets"], (d["hyperlinks"], d["targets"]))
                        check(f"{layout}/{lang}: DOCX carries the name", name.split()[0] in d["xml"])

            # One layout, the other exports and options.
            page.evaluate("([k, v]) => localStorage.setItem(k, JSON.stringify(v))", ["samurai-knife:cv-studio:v1", {"theme:variants": "modern", "lang:variants": "en", "pages:variants": "cv+pages", "paper:variants": "letter", "urls:variants": "full"}])
            page.goto("/tools/cv-studio?tab=variants", wait_until="networkidle")
            page.wait_for_selector("[data-cv-document][data-pages=after][data-paper=letter]", timeout=30_000)
            status, pdf, _ = export("pdf", "en", "modern", {"pageMode": "cv+pages", "paper": "letter", "fullUrls": True})
            info = inspect_pdf(pdf) if status == 200 else {"pages": 0, "text": "", "links": []}
            check("CV + project pages: the queuectl page follows the CV", info["pages"] >= 2 and "Author and maintainer" in info["text"] and "replays messages" in " ".join(info["text"].split()), info["text"][-400:])
            check("full URLs print with https://", "https://github.com/ola-example" in " ".join(info["text"].split()), info["text"][:300])
            box = subprocess.run([PY, "-I", "-c", "import io,sys;from pypdf import PdfReader;b=PdfReader(io.BytesIO(sys.stdin.buffer.read())).pages[0].mediabox;print(round(float(b.width)),round(float(b.height)))"], input=pdf, capture_output=True, text=False).stdout.decode().split()
            check("Letter paper is 612x792 pt", box == ["612", "792"], box)
            page.evaluate("([k, v]) => localStorage.setItem(k, JSON.stringify(v))", ["samurai-knife:cv-studio:v1", {"theme:variants": "modern", "lang:variants": "en", "pages:variants": "pages"}])
            page.goto("/tools/cv-studio?tab=variants", wait_until="networkidle")
            page.wait_for_selector("[data-cv-document][data-pages=only]", timeout=30_000)
            status, pdf, _ = export("pdf", "en", "modern", {"pageMode": "pages"})
            info = inspect_pdf(pdf) if status == 200 else {"pages": 0, "text": ""}
            check("project pages only: one page, no CV sections", info["pages"] == 1 and "queuectl" in info["text"] and "Experience" not in info["text"], info)
            status, html, _ = export("html", "en", "modern", {"pageMode": "pages"})
            text = html.decode("utf-8", "replace")
            check("HTML export: one self-contained file (fonts embedded, no external URL, no script)", status == 200 and "data:font/woff2;base64," in text and "<script" not in text and 'src="http' not in text, text[:200])
            status, txt, _ = export("txt", "en", "modern")
            check("TXT export: the ATS text", status == 200 and txt.decode().startswith(PROFILE["contact"]["name"]) and "EXPERIENCE" in txt.decode(), txt[:200])
            status, _, _ = page.evaluate("""() => fetch('/api/cv/export', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({variantId:null, lang:'en', theme:'ats', format:'pdf', sheet:'<div>not a cv</div>'})}).then(r => [r.status, '', ''])""")
            check("a foreign sheet is refused", status == 422, status)
            check("no console errors", not errors, errors[:3])
            browser.close()

    if shots:
        from PIL import Image, ImageDraw  # noqa: PLC0415 - test-only, optional
        thumbs = [(label, Image.open(p).convert("RGB")) for label, p in shots]
        w = max(im.width for _, im in thumbs)
        h = max(im.height for _, im in thumbs)
        cols = 7
        rows = (len(thumbs) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * (w + 16) + 16, rows * (h + 40) + 16), "#d9dce1")
        draw = ImageDraw.Draw(sheet)
        for i, (label, im) in enumerate(thumbs):
            x, y = 16 + (i % cols) * (w + 16), 16 + (i // cols) * (h + 40)
            sheet.paste(im, (x, y + 22))
            draw.text((x, y + 4), label, fill="#111111")
        target = Path(os.environ.get("CV_SHEET", OUT / "contact-sheet.png"))
        sheet.save(target)
        print(f"contact sheet: {target}")
    if "--keep" not in sys.argv:
        for p in OUT.glob("*.pdf"):
            p.unlink()
        for p in OUT.glob("*-*.png"):
            p.unlink()
    print(f"\n{PASSES} passed, {len(FAILS)} failed")
    if FAILS:
        print("FAILED:", FAILS[:20])
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
