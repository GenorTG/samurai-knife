#!/usr/bin/env python3
"""Install app-local Polish OCR data, keeping system Tesseract unchanged.

Run with ../samurai-knife-py/venv/bin/python server/py/setup_ocr.py.
Requires Tesseract with eng/osd and configs already installed on the host.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request

POL_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/pol.traineddata"
POL_SHA256 = "c4476cdbc0e33d898d32345122b7be1cbf85ace15f920f06c7714756e1ef79b2"


def main() -> None:
    if sys.prefix == sys.base_prefix:
        raise SystemExit("Run this setup with the PDF worker venv Python, not system Python.")
    probe = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, check=True, timeout=10)
    match = re.search(r'"([^"\n]+)"', probe.stdout + probe.stderr)
    if not match:
        raise SystemExit("Could not locate Tesseract tessdata from --list-langs.")
    source = Path(match.group(1))
    for relative in ("eng.traineddata", "osd.traineddata", "configs"):
        if not (source / relative).exists():
            raise SystemExit(f"Tesseract is missing {relative}. Install its English/orientation data and configs first.")
    target = Path(sys.prefix) / "share" / "knife-tessdata"
    target.mkdir(parents=True, exist_ok=True)
    if source.resolve() != target.resolve():
        for language in ("eng", "osd"):
            shutil.copy2(source / f"{language}.traineddata", target)
        shutil.copytree(source / "configs", target / "configs", dirs_exist_ok=True)
    with urllib.request.urlopen(POL_URL, timeout=60) as response:
        polish = response.read()
    if hashlib.sha256(polish).hexdigest() != POL_SHA256:
        raise SystemExit("Polish language data checksum mismatch; nothing installed for pol.")
    temporary = target / "pol.traineddata.part"
    temporary.write_bytes(polish)
    temporary.replace(target / "pol.traineddata")
    subprocess.run(["tesseract", "--tessdata-dir", str(target), "--list-langs"], check=True)
    print(f"OCR language data ready in {target}; system Tesseract was not changed.")


if __name__ == "__main__":
    main()
