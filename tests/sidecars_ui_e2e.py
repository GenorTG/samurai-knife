"""Sidecar services page driven like a person (real docker): Install button -> live progress (role=status + meter) ->
Running badge -> Stop -> Start -> Remove with the confirm + purge checkbox. Also: the office page shows the install card
while the sidecar is missing. Same isolation as tests/office_e2e.py (scratch worktree server on the Tailscale address,
own data dir/port/compose project). Uses the cached image when present (pull is then seconds).

    python3 tests/sidecars_ui_e2e.py [--host <tailscale-or-LAN-ip>] [--shots DIR]
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scratch_server import ScratchServer  # noqa: E402

from playwright.sync_api import expect, sync_playwright  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{f' — {detail}' if detail else ''}", flush=True)


def project_containers(project: str) -> list[str]:
    out = subprocess.run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.Names}}"], capture_output=True, text=True)
    return out.stdout.split()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("KNIFE_E2E_HOST") or os.environ.get("KNIFE_HOST"))
    parser.add_argument("--shots", default="")
    args = parser.parse_args()
    shots = Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    prefix = f"sk-ui-{os.getpid()}"
    project = f"{prefix}-office"
    server = ScratchServer(host=args.host)
    url = server.start(env={"KNIFE_SIDECAR_PREFIX": prefix})
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 1000})
            page.goto(f"{url}/tools/office")
            card = page.locator(".sk-sidecar-card")
            card.wait_for(timeout=60_000)
            check("office page shows the install card while not installed", card.get_by_role("button", name="Install office editor").is_visible())
            check("library usable without the sidecar", page.get_by_role("button", name="Create").is_visible())
            if shots:
                page.screenshot(path=str(shots / "office-not-installed.png"), full_page=True)

            page.goto(f"{url}/tools/sidecars")
            # The Sidecar services page lists every sidecar (office, learn-db): this suite drives the office card.
            card = page.locator(".sk-sidecar-card").filter(has_text="Office editor (Euro-Office Document Server)")
            card.wait_for(timeout=60_000)
            expect(card.get_by_text("Not installed", exact=True)).to_be_visible(timeout=30_000)
            card.get_by_role("button", name="Install office editor").click()
            status = card.get_by_role("status").first
            seen: list[str] = []
            deadline = time.monotonic() + 900
            while time.monotonic() < deadline:
                text = status.inner_text() if status.count() else ""
                if text and (not seen or seen[-1] != text.split("(")[0]):
                    seen.append(text.split("(")[0])
                if card.get_by_text("Running", exact=True).count():
                    break
                time.sleep(0.5)
            check("Install shows live phases in role=status", len(seen) >= 3, " | ".join(seen[:8]))
            check("badge turns Running after install", card.get_by_text("Running", exact=True).count() == 1)
            if shots:
                page.screenshot(path=str(shots / "sidecars-running.png"), full_page=True)
            card.get_by_role("button", name="Stop").click()
            expect(card.get_by_text("Stopped", exact=True)).to_be_visible(timeout=120_000)
            check("Stop button stops it", True)
            t0 = time.monotonic()
            card.get_by_role("button", name="Start").click()
            expect(card.get_by_text("Running", exact=True)).to_be_visible(timeout=300_000)
            check("Start button starts it", True, f"{time.monotonic() - t0:.1f} s to Running")
            card.get_by_role("button", name="Remove…").click()
            card.get_by_label("Also delete its data volumes and secrets").check()
            card.get_by_role("button", name="Confirm remove").click()
            expect(card.get_by_text("Not installed", exact=True)).to_be_visible(timeout=180_000)
            check("Remove with purge returns to Not installed", True)
            browser.close()
        check("no container left in the UI test project", not project_containers(project), str(project_containers(project)))
    finally:
        leftovers = project_containers(project)
        if leftovers:
            subprocess.run(["docker", "rm", "-f", *leftovers], capture_output=True)
        vols = subprocess.run(["docker", "volume", "ls", "-q", "--filter", f"label=com.docker.compose.project={project}"], capture_output=True, text=True).stdout.split()
        if vols:
            subprocess.run(["docker", "volume", "rm", *vols], capture_output=True)
        server.stop()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
