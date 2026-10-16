/**
 * The environment a child process (Python lane, `gh`, `git`) gets: an allow-list of what tools need to run, never the
 * server's own variables (provider keys, SMTP credentials, session secrets live there). A parser exploit in a child then
 * has nothing to exfiltrate beyond its own request.
 */

const BASE_KEYS = ["PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "USER", "LOGNAME"];

export function childEnv(extraKeys: readonly string[] = [], overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of [...BASE_KEYS, ...extraKeys]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Next types NODE_ENV as required on ProcessEnv; a child only gets it when the server has it.
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

/** Python lane: OCR data paths and thread caps on top of the base set. */
export const PYTHON_ENV_KEYS = ["TESSDATA_PREFIX", "OMP_THREAD_LIMIT", "OMP_NUM_THREADS", "PYTHONIOENCODING"] as const;

/** docker / podman compose (admin-only sidecar ops): daemon address, config and rootless runtime dirs. */
export const RUNTIME_ENV_KEYS = [
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "CONTAINER_HOST",
  "CONTAINERS_CONF",
] as const;

/**
 * `gh` / `git` for the admin-only showcase gatherers: the owner's own login (config dir or token) is the point there,
 * so these pass, but nothing else of the server does.
 */
export const GIT_ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;
