"""Configure a scratch Samurai Knife server with a real provider.

Providers (env KNIFE_REAL_PROVIDER):
  opencode-go (default)  OpenCode Go; key read from the OpenClaw auth profile file.
  KNIFE_REAL_ACCOUNT=<id>  (any provider) read that Knife account's provider block (URL, model, key, extra headers)
                         from the LIVE accounts.json, READ-ONLY, and hand it to the scratch server. Set it up once with
                         `npm run accounts -- set-provider <id> ...` (see docs/TESTING.md). Wins over KNIFE_REAL_PROVIDER.
  openclaw-gateway       the local OpenClaw gateway's OpenAI-compatible endpoint (docs/gateway/openai-http-api.md).
                         Every request is a full AGENT RUN, `model` is an agent target (`openclaw/<agentId>`), not a
                         provider model. Needs KNIFE_GATEWAY_AGENT (explicit on purpose, see below) and the gateway token
                         in $OPENCLAW_GATEWAY_TOKEN or the 0600 file $OPENCLAW_GATEWAY_TOKEN_FILE
                         (default ~/.openclaw/secrets/gateway-api-token). Optional: KNIFE_GATEWAY_URL
                         (default http://127.0.0.1:18789/v1), KNIFE_GATEWAY_MODEL (sent as x-openclaw-model to pick the
                         backend model, shared-secret callers only).

The key is read at runtime and sent straight to the scratch server's /api/account/provider (a throwaway data dir).
It is never printed or written anywhere else. Never point the REAL account (live data dir) at the gateway: the token is
a full operator credential.
"""
import json
import os
import subprocess
import urllib.request
import uuid

BASE_URL = "https://opencode.ai/zen/go/v1"
KEY_FILE = os.path.expanduser(os.environ.get("OPENCODE_AUTH_FILE", "~/.openclaw/backups/2026-06-05/auth-profiles.json"))


PROVIDER = os.environ.get("KNIFE_REAL_PROVIDER", "opencode-go")
GATEWAY_URL = os.environ.get("KNIFE_GATEWAY_URL", "http://127.0.0.1:18789/v1").rstrip("/")
GATEWAY_TOKEN_FILE = os.path.expanduser(os.environ.get("OPENCLAW_GATEWAY_TOKEN_FILE", "~/.openclaw/secrets/gateway-api-token"))
# These agent targets are the main OpenClaw agent (exec, elevated, messaging): tests must not run as her by accident.
_DEFAULT_AGENT_TARGETS = {"openclaw", "openclaw/default", "openclaw/main", "openclaw:main", "agent:main"}


ACCOUNT = os.environ.get("KNIFE_REAL_ACCOUNT", "").strip()
ACCOUNTS_FILE = os.path.join(os.path.expanduser(os.environ.get("KNIFE_ACCOUNTS_DIR", "~/.local/share/samurai-knife")), "accounts.json")


def _account_provider() -> dict:
    """The provider block of a Knife account (live data dir, read-only). Never printed."""
    try:
        with open(ACCOUNTS_FILE) as fh:
            accounts = json.load(fh)["accounts"]
    except (OSError, ValueError, KeyError) as exc:
        raise SystemExit(f"cannot read {ACCOUNTS_FILE}: {exc.__class__.__name__}") from None
    account = next((a for a in accounts if a.get("id") == ACCOUNT), None)
    provider = account.get("provider") if account else None
    if provider and "enc:v1:" in json.dumps(provider):
        # Keys are sealed at rest (provider-keys.key next to accounts.json): the accounts CLI opens them, read-only.
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = {**os.environ, "KNIFE_DATA_DIR": os.path.dirname(ACCOUNTS_FILE)}
        done = subprocess.run(["node", os.path.join(root, "scripts", "accounts.mjs"), "provider-json", ACCOUNT], env=env, capture_output=True, text=True)
        if done.returncode != 0:
            raise SystemExit(f"cannot open the sealed provider of {ACCOUNT!r}: {done.stderr.strip()[:200]}")
        provider = json.loads(done.stdout)
    if not provider or not provider.get("apiKey"):
        raise SystemExit(f"account {ACCOUNT!r} has no provider with a key: `npm run accounts -- set-provider {ACCOUNT} ...` first")
    return provider


def _gateway_token() -> str:
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if not token:
        try:
            with open(GATEWAY_TOKEN_FILE) as fh:
                token = fh.read().strip()
        except OSError:
            token = ""
        if not token:
            raise SystemExit(
                f"no gateway token: set OPENCLAW_GATEWAY_TOKEN or put it in {GATEWAY_TOKEN_FILE} (mode 600; the file is missing or empty). "
                "Reveal it in an interactive terminal with `openclaw gateway auth-token --show` (see docs/TESTING.md, section 'Real model via the OpenClaw gateway')."
            )
    return token


def _gateway_agent() -> str:
    agent = os.environ.get("KNIFE_GATEWAY_AGENT", "").strip()
    if not agent:
        raise SystemExit("KNIFE_GATEWAY_AGENT is required (e.g. openclaw/knife-test): the endpoint runs a full OpenClaw agent, choose which one on purpose.")
    if agent in _DEFAULT_AGENT_TARGETS and os.environ.get("KNIFE_GATEWAY_ALLOW_MAIN") != "1":
        raise SystemExit(f"refusing agent target {agent!r}: it is the main agent with exec/elevated tools. Use a restricted test agent, or set KNIFE_GATEWAY_ALLOW_MAIN=1 to accept the risk.")
    return agent


def _read_key() -> str:
    if ACCOUNT:
        return _account_provider()["apiKey"]
    if PROVIDER == "openclaw-gateway":
        return _gateway_token()
    with open(KEY_FILE) as fh:
        return json.load(fh)["profiles"]["opencode-go:default"]["key"]


def _provider_body(model: str) -> dict:
    if ACCOUNT:
        p = _account_provider()
        return {"baseUrl": p["baseUrl"], "model": p["model"], "apiKey": p["apiKey"], "extraHeaders": p.get("extraHeaders") or {}}
    if PROVIDER == "openclaw-gateway":
        headers: dict[str, str] = {}
        if os.environ.get("KNIFE_GATEWAY_MODEL"):
            headers["x-openclaw-model"] = os.environ["KNIFE_GATEWAY_MODEL"]
        return {"baseUrl": GATEWAY_URL, "model": _gateway_agent(), "apiKey": _gateway_token(), "extraHeaders": headers}
    return {
        "baseUrl": BASE_URL,
        "model": model,
        "apiKey": _read_key(),
        "extraHeaders": {"x-opencode-session": f"sk-test-{uuid.uuid4().hex[:12]}"},
    }


def configure(app_url: str, model: str = "deepseek-v4.1-flash", reasoning_effort: str | None = None) -> None:
    body = _provider_body(model)
    if reasoning_effort:
        body["reasoningEffort"] = reasoning_effort
    req = urllib.request.Request(
        app_url.rstrip("/") + "/api/account/provider", data=json.dumps(body).encode(), method="PUT",
        headers={"content-type": "application/json", "Origin": app_url.rstrip("/")},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            res.read()
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"configure provider failed: HTTP {exc.code}") from None
