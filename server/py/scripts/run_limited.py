"""Run one lane script under resource limits: `python run_limited.py <script.py> <args...>`.

src/lib/python.ts starts every script through this file. The limits come from the environment the runner passes
(KNIFE_RLIMIT_AS_MB, KNIFE_RLIMIT_CPU_SEC, KNIFE_RLIMIT_FSIZE_MB; 0 or unset = leave as is) and are inherited by
anything the script starts (ocrmypdf, tesseract). Address space caps memory (a decompression bomb or a huge page render
fails with MemoryError instead of taking the host down), CPU seconds cap a busy loop across threads, file size caps
what one write may produce, and core dumps are off. The wall-clock timeout stays with the Node side.
"""
import os
import resource
import runpy
import sys

MB = 1024 * 1024


def limit(name: int, value: int) -> None:
    if value <= 0:
        return
    soft, hard = resource.getrlimit(name)
    target = value if hard == resource.RLIM_INFINITY else min(value, hard)
    resource.setrlimit(name, (target, hard if hard != resource.RLIM_INFINITY else target))


def env_int(key: str) -> int:
    try:
        return max(0, int(os.environ.get(key, "0")))
    except ValueError:
        return 0


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: run_limited.py <script.py> [args...]")
    limit(resource.RLIMIT_AS, env_int("KNIFE_RLIMIT_AS_MB") * MB)
    limit(resource.RLIMIT_CPU, env_int("KNIFE_RLIMIT_CPU_SEC"))
    limit(resource.RLIMIT_FSIZE, env_int("KNIFE_RLIMIT_FSIZE_MB") * MB)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    script = sys.argv[1]
    sys.argv = sys.argv[1:]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
