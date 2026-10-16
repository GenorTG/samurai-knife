"""A throwaway Samurai Knife server for tests: own worktree, own data dir, free loopback port, removed on exit.

Why a worktree: `next dev` refuses a second server in the same directory and the live instance (PM2, :3210) holds the lock of
the main checkout's `.next`, so the server runs from a worktree of the CURRENT tree (HEAD plus tracked edits, node_modules
hard-linked, `next typegen` run once). `--in-place` style use (in_place=True) skips that and serves the checkout itself, only
for when nothing else runs from it.

Ownership rules (see docs/TESTING.md): this class only ever stops the process IT started and only deletes what it created.
An explicit base URL given to a runner bypasses this class entirely.

    with ScratchServer() as server:
        url = server.start()          # fresh data dir
        ...
        url = server.restart()        # same code, brand-new data dir (suites that refuse a used data dir)
        server.restart(env={"KNIFE_PY_LIGHT": "4"})
"""
from __future__ import annotations

import atexit
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout.strip()


def free_port(host: str = "127.0.0.1") -> int:
    """Any free port, or the first free one in KNIFE_SCRATCH_PORTS ("3350-3369") when a run must stay in a range."""
    span = os.environ.get("KNIFE_SCRATCH_PORTS", "").strip()
    if span:
        low, _, high = span.partition("-")
        for port in range(int(low), int(high or low) + 1):
            with socket.socket() as sock:
                try:
                    sock.bind((host, port))
                except OSError:
                    continue
                return port
        raise RuntimeError(f"no free port in KNIFE_SCRATCH_PORTS={span}")
    with socket.socket() as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


class ScratchServer:
    def __init__(self, in_place: bool = False, ready_timeout: float = 180.0, host: str = "127.0.0.1") -> None:
        # `host` = KNIFE_HOST of the scratch server. Loopback by default; a sidecar e2e binds the Tailscale address,
        # because a container cannot reach the host's loopback (docs/SIDECARS.md).
        self.host = host
        self.in_place = in_place
        self.ready_timeout = ready_timeout
        self.url = ""
        self.data_dir: Path | None = None
        self._tmp: tempfile.TemporaryDirectory[str] | None = None
        self._worktree: Path | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._log = None
        self._runs = 0
        atexit.register(self.stop)

    # -- lifecycle ------------------------------------------------------------------------------------------------
    def __enter__(self) -> "ScratchServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self, env: dict[str, str] | None = None, overlay: list[str] | None = None) -> str:
        """`overlay`: repo-relative paths copied from this checkout into the worktree before the server starts, for
        UNTRACKED files the run needs (the worktree is built from `git stash create`, which holds tracked edits only)."""
        if self._proc is not None:
            return self.restart(env)
        if self._tmp is None:
            # KNIFE_SCRATCH_PREFIX names the temp dir (data dir = <it>/data-N), e.g. to keep a run's files findable.
            self._tmp = tempfile.TemporaryDirectory(prefix=os.environ.get("KNIFE_SCRATCH_PREFIX", "samurai-knife-scratch-"))
        scratch = Path(self._tmp.name)
        if not self.in_place and self._worktree is None:
            ref = _git("stash", "create") or "HEAD"
            self._worktree = scratch / "wt"
            _git("worktree", "add", "--detach", str(self._worktree), ref)
            subprocess.run(["cp", "-al", str(ROOT / "node_modules"), str(self._worktree / "node_modules")], check=True)
            for rel in overlay or []:
                src, dst = ROOT / rel, self._worktree / rel
                if src.is_dir():
                    shutil.copytree(src, dst, dirs_exist_ok=True)
                elif src.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
            subprocess.run(["npx", "next", "typegen"], cwd=self._worktree, check=True, capture_output=True)
        self._runs += 1
        self.data_dir = scratch / f"data-{self._runs}"
        self.data_dir.mkdir()
        port = free_port(self.host)
        child_env = os.environ.copy()
        child_env.update({"KNIFE_HOST": self.host, "KNIFE_PORT": str(port), "KNIFE_DATA_DIR": str(self.data_dir), **(env or {})})
        self._log = (scratch / f"server-{self._runs}.log").open("w+")
        self._proc = subprocess.Popen(
            ["npm", "run", "dev"], cwd=self._worktree or ROOT, env=child_env, stdout=self._log, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        self.url = f"http://{self.host}:{port}"
        self._wait_ready()
        return self.url

    def restart(self, env: dict[str, str] | None = None) -> str:
        self._stop_process()
        return self.start(env)

    def stop(self) -> None:
        self._stop_process()
        if self._worktree is not None:
            subprocess.run(["git", "worktree", "remove", "--force", str(self._worktree)], cwd=ROOT, capture_output=True)
            self._worktree = None
        if self._tmp is not None:
            self._tmp.cleanup()
            self._tmp = None

    def log_tail(self, chars: int = 4000) -> str:
        if self._log is None:
            return ""
        self._log.flush()
        self._log.seek(0)
        return self._log.read()[-chars:]

    @property
    def cwd(self) -> Path:
        """The checkout the server runs from (its worktree). Suites whose oracle inspects this checkout's processes (queue_e2e) run here."""
        return self._worktree or ROOT

    # -- internals ------------------------------------------------------------------------------------------------
    def _stop_process(self) -> None:
        proc, self._proc = self._proc, None
        if proc is not None:
            # npm -> node -> next-server: signal the whole session group, not just npm.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(proc.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    proc.wait(timeout=15)
                    break
                except subprocess.TimeoutExpired:
                    continue
        if self._log is not None:
            self._log.close()
            self._log = None

    def _wait_ready(self) -> None:
        assert self._proc is not None
        deadline = time.monotonic() + self.ready_timeout
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                break
            try:
                with urllib.request.urlopen(self.url, timeout=2):
                    return
            except (urllib.error.URLError, TimeoutError, OSError):
                time.sleep(0.5)
        tail = self.log_tail(6000)
        self.stop()
        raise RuntimeError(f"Scratch server failed to become ready at {self.url}. Log tail:\n{tail}")
