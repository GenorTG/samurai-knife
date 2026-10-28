"""Screenshot one page of the user's website: `python site_screenshot.py request.json response.json`.

Started by src/lib/vision/screenshot.ts through the Python lane (heavy lane, bubblewrap sandbox in public mode). The
sandbox has no network: Chromium reaches the web only through the HTTP proxy the server runs on a unix socket inside
this job's scratch dir (`proxySocket`), which checks every connection against the outbound address policy (no
loopback, LAN, metadata or Tailscale addresses in public mode) and caps the job's connections and bytes. This script
relays 127.0.0.1:<port> (the sandbox's own loopback) to that socket, so Chromium can use it as an ordinary proxy.

Request: {url, allowedOrigins[], viewport {width, height}, fullPage, maxHeight, format "png"|"jpeg", quality,
maxBytes, timeoutMs, maxRequests, chromium (executable), proxySocket, outFile, bypass? {host, headers}}.
Response: {ok, data: {file, mime, width, height, bytes, finalUrl, title, status, truncated, requests, blocked}}.

Rules enforced here (the proxy enforces the network ones):
- Top-level navigations of the main frame stay on `allowedOrigins` (a redirect elsewhere is aborted).
- Only http(s) requests leave the page; service workers, downloads, popups and dialogs are refused.
- The protection-bypass header goes only to requests whose host is `bypass.host`, never to another host.
"""
import asyncio
import json
import posixpath
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


class ToolError(Exception):
    pass


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return ""
    default = {"http": 80, "https": 443}[parts.scheme]
    port = parts.port or default
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    return f"{parts.scheme}://{host}" + ("" if port == default else f":{port}")


def path_under_allowed_prefix(url: str, prefixes: list[str]) -> bool:
    path = unquote(urlsplit(url).path)
    if "\\" in path or "\x00" in path:
        return False
    normalized = posixpath.normpath(path).casefold()
    return any(
        normalized == prefix.casefold()
        or normalized.startswith(prefix.rstrip("/").casefold() + "/")
        for prefix in prefixes
    )


async def relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, socket_path: str) -> None:
    """One Chromium connection to the sandbox loopback -> the server's proxy socket, both directions."""
    try:
        up_reader, up_writer = await asyncio.open_unix_connection(socket_path)
    except OSError:
        writer.close()
        return

    async def pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await src.read(65536)
                if not chunk:
                    break
                dst.write(chunk)
                await dst.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                dst.close()
            except OSError:
                pass

    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))


def int_field(req: dict, key: str, low: int, high: int, default: int) -> int:
    value = req.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ToolError(f"request: {key} must be an integer.")
    return max(low, min(high, value))


async def capture(req: dict) -> dict:
    from playwright.async_api import async_playwright  # imported late: a missing package is a clean error

    url = req.get("url")
    if not isinstance(url, str) or not origin_of(url):
        raise ToolError("request: url must be an http(s) URL.")
    allowed = {origin_of(o) for o in req.get("allowedOrigins") or [] if isinstance(o, str)} - {""}
    if origin_of(url) not in allowed:
        raise ToolError("request: url is not on an allowed origin.")
    raw_paths = req.get("allowedPaths") or []
    if not isinstance(raw_paths, list):
        raise ToolError("request: allowedPaths must be a list.")
    allowed_paths = []
    for prefix in raw_paths:
        if not isinstance(prefix, str) or not prefix.startswith("/") or prefix.startswith("//") or any(c in prefix for c in "?#\\\x00"):
            raise ToolError("request: invalid allowed path prefix.")
        decoded = unquote(prefix)
        if decoded.startswith("//") or any(segment in (".", "..") for segment in decoded.split("/")):
            raise ToolError("request: invalid allowed path prefix.")
        normalized = posixpath.normpath(decoded)
        if normalized == "/":
            raise ToolError("request: invalid allowed path prefix.")
        allowed_paths.append(normalized.rstrip("/"))

    def navigation_allowed(target: str) -> bool:
        return origin_of(target) in allowed and (not allowed_paths or path_under_allowed_prefix(target, allowed_paths))
    viewport = req.get("viewport") or {}
    width = int_field(viewport, "width", 320, 1920, 1280)
    height = int_field(viewport, "height", 320, 1600, 800)
    max_height = int_field(req, "maxHeight", height, 8000, 4000)
    timeout_ms = int_field(req, "timeoutMs", 5000, 90000, 30000)
    max_requests = int_field(req, "maxRequests", 1, 2000, 300)
    quality = int_field(req, "quality", 30, 95, 80)
    max_bytes = int_field(req, "maxBytes", 50_000, 20_000_000, 4_000_000)
    fmt = "jpeg" if req.get("format") == "jpeg" else "png"
    full_page = req.get("fullPage") is True
    out_file = req.get("outFile")
    socket_path = req.get("proxySocket")
    chromium = req.get("chromium")
    if not isinstance(out_file, str) or not isinstance(socket_path, str) or not isinstance(chromium, str):
        raise ToolError("request: outFile, proxySocket and chromium are required.")
    bypass = req.get("bypass") if isinstance(req.get("bypass"), dict) else None

    server = await asyncio.start_server(lambda r, w: relay(r, w, socket_path), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    counters = {"requests": 0, "blocked": 0}
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                executable_path=chromium,
                headless=True,
                proxy={"server": f"http://127.0.0.1:{port}", "bypass": "<-loopback>"},
                args=[
                    # bubblewrap is the sandbox (no user namespaces inside it): Chromium's own cannot start.
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-quic",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-sync",
                    "--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider",
                    "--renderer-process-limit=2",
                    "--js-flags=--max-old-space-size=512",
                    "--no-first-run",
                    "--mute-audio",
                ],
            )
            try:
                context = await browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                    service_workers="block",
                    accept_downloads=False,
                    locale="en-US",
                    is_mobile=width < 600,
                    has_touch=width < 600,
                )
                page = await context.new_page()
                page.on("dialog", lambda d: asyncio.ensure_future(d.dismiss()))
                context.on("page", lambda p: asyncio.ensure_future(p.close()) if p is not page else None)

                async def route(route_, request):
                    target = request.url
                    scheme = urlsplit(target).scheme
                    if scheme not in ("http", "https"):
                        counters["blocked"] += 1
                        await route_.abort()
                        return
                    counters["requests"] += 1
                    if counters["requests"] > max_requests:
                        counters["blocked"] += 1
                        await route_.abort()
                        return
                    if request.is_navigation_request() and request.frame == page.main_frame and not navigation_allowed(target):
                        counters["blocked"] += 1
                        await route_.abort()
                        return
                    # netloc = host[:port] exactly as the server's URL.host (default ports omitted on both sides).
                    host = urlsplit(target).netloc.rsplit("@", 1)[-1].lower()
                    if bypass and host and host == str(bypass.get("host", "")).lower():
                        headers = {**request.headers, **{str(k): str(v) for k, v in (bypass.get("headers") or {}).items()}}
                        await route_.continue_(headers=headers)
                        return
                    await route_.continue_()

                await page.route("**/*", route)
                response = None
                try:
                    response = await page.goto(url, wait_until="load", timeout=timeout_ms)
                except Exception as exc:  # noqa: BLE001 - a slow page still gets its screenshot
                    if "Timeout" not in type(exc).__name__ and "timeout" not in str(exc).lower():
                        raise ToolError(f"the page did not load: {str(exc).splitlines()[0][:300]}") from exc
                try:
                    await page.wait_for_load_state("networkidle", timeout=4000)
                except Exception:  # noqa: BLE001 - pages that keep polling never idle
                    pass
                await page.wait_for_timeout(300)
                final_url = page.url
                if not navigation_allowed(final_url):
                    raise ToolError("the page left the allowed site before the screenshot.")
                title = (await page.title())[:300]
                doc_height = await page.evaluate("() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")
                shot_height = height
                truncated = False
                if full_page:
                    shot_height = max(height, min(int(doc_height or height), max_height))
                    truncated = int(doc_height or 0) > max_height
                options = {"type": fmt, "clip": {"x": 0, "y": 0, "width": width, "height": shot_height}, "full_page": full_page, "animations": "disabled", "timeout": 15000}
                if fmt == "jpeg":
                    options["quality"] = quality
                data = await page.screenshot(**options)
                # Too big: JPEG at falling quality, then fewer rows, until it fits.
                attempts = 0
                while len(data) > max_bytes and attempts < 6:
                    attempts += 1
                    fmt = "jpeg"
                    quality = max(30, quality - 15)
                    if attempts >= 3:
                        shot_height = max(height, int(shot_height * 0.6))
                        truncated = True
                    options = {"type": "jpeg", "quality": quality, "clip": {"x": 0, "y": 0, "width": width, "height": shot_height}, "full_page": full_page, "animations": "disabled", "timeout": 15000}
                    data = await page.screenshot(**options)
                if len(data) > max_bytes:
                    raise ToolError("the screenshot is larger than the size limit.")
                Path(out_file).write_bytes(data)
                return {
                    "file": Path(out_file).name,
                    "mime": "image/jpeg" if fmt == "jpeg" else "image/png",
                    "width": width,
                    "height": shot_height,
                    "bytes": len(data),
                    "finalUrl": final_url,
                    "title": title,
                    "status": response.status if response else None,
                    "truncated": truncated,
                    "requests": counters["requests"],
                    "blocked": counters["blocked"],
                }
            finally:
                await browser.close()
    finally:
        server.close()


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: site_screenshot.py request.json response.json\n")
        return 2
    request_path, response_path = sys.argv[1], sys.argv[2]
    try:
        req = json.loads(Path(request_path).read_text("utf-8"))
        if not isinstance(req, dict):
            raise ToolError("request: expected a JSON object.")
        result = {"ok": True, "data": asyncio.run(capture(req))}
    except ToolError as exc:
        result = {"ok": False, "error": str(exc)}
    except ModuleNotFoundError as exc:
        result = {"ok": False, "error": f"screenshots need the Python package playwright on this server ({exc.name} missing)."}
    except Exception as exc:  # noqa: BLE001 - surface anything as a clean message
        result = {"ok": False, "error": f"{type(exc).__name__}: {str(exc).splitlines()[0][:300] if str(exc) else ''}"}
        sys.stderr.write(repr(exc)[:2000] + "\n")
    Path(response_path).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
