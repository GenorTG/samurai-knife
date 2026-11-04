-- Core table data: accounts (+ provider profiles), sessions, MCP keys, instance settings (docs/DB-POSTGRES.md).
-- Plain SQL, applied once by scripts/db-migrate.mjs inside one transaction under an advisory lock, never by the app.
-- Secrets: provider API keys and extra-header values arrive already sealed by the app (secret-box.ts, AES-256-GCM, key
-- file provider-keys.key outside the database); sessions and MCP keys are SHA-256 hashes only. Nothing here can open them.

CREATE TABLE instance_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per account. `doc` is the account record in the accounts.json v2 shape WITHOUT providerProfiles (own table),
-- provider secrets sealed; the plain columns are copies for constraints and queries, written by knife_apply_core only.
CREATE TABLE accounts (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  email text CHECK (email IS NULL OR email = lower(email)),
  github_id bigint,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at timestamptz NOT NULL,
  last_login_at timestamptz,
  doc jsonb NOT NULL CHECK (jsonb_typeof(doc) = 'object' AND NOT doc ? 'providerProfiles'),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Deferred: one batch may move an address from one account to another; only the committed state must be unique.
  CONSTRAINT accounts_email_key UNIQUE (email) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT accounts_github_id_key UNIQUE (github_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX accounts_pending_created ON accounts (created_at) WHERE status = 'pending';

CREATE TABLE provider_profiles (
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-z0-9]{1,24}$'),
  position integer NOT NULL,
  name text NOT NULL,
  config jsonb NOT NULL,
  PRIMARY KEY (account_id, id)
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE CASCADE,
  pw_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE mcp_keys (
  id text PRIMARY KEY,
  key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  account_id text NOT NULL REFERENCES accounts (id) ON DELETE CASCADE ON UPDATE CASCADE,
  name text NOT NULL,
  hint text NOT NULL,
  scope text CHECK (scope IS NULL OR scope IN ('full', 'read-only')),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz
);
CREATE INDEX mcp_keys_account ON mcp_keys (account_id);

-- ISO-8601 the way Date.prototype.toISOString writes it (what the files hold), so both backends read the same strings.
CREATE FUNCTION knife_iso(ts timestamptz) RETURNS text LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- The whole core state in ONE round trip (startup warm-up, reload after a NOTIFY or a failed commit).
CREATE FUNCTION knife_load_core() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'defaultAccountId', (SELECT value FROM instance_settings WHERE key = 'defaultAccountId'),
    'accounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'version', a.version::text,
        'doc', a.doc || jsonb_build_object('providerProfiles', coalesce((
          SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'config', p.config) ORDER BY p.position)
          FROM provider_profiles p WHERE p.account_id = a.id), '[]'::jsonb))
      ) ORDER BY a.seq)
      FROM accounts a), '[]'::jsonb),
    'sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('hash', s.token_hash, 'accountId', s.account_id, 'pf', s.pw_fingerprint,
        'createdAt', knife_iso(s.created_at), 'expiresAt', knife_iso(s.expires_at), 'lastSeenAt', knife_iso(s.last_seen_at))
        ORDER BY s.created_at, s.token_hash)
      FROM sessions s), '[]'::jsonb),
    'keys', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', k.id, 'accountId', k.account_id, 'name', k.name, 'hash', k.key_hash,
        'hint', k.hint, 'createdAt', knife_iso(k.created_at),
        'lastUsedAt', CASE WHEN k.last_used_at IS NULL THEN NULL ELSE knife_iso(k.last_used_at) END, 'scope', k.scope)
        ORDER BY k.created_at, k.id)
      FROM mcp_keys k), '[]'::jsonb)
  )
$$;

-- One commit batch = ONE statement = one round trip and one transaction (the caller sends it as a prepared statement).
-- change = {
--   origin: text,                                  -- writer id, echoed in the NOTIFY so a writer ignores its own changes
--   defaultAccountId?: text,
--   accounts?: { upsert?: [{ doc, expect: text|null }], delete?: [{ id, expect: text }] },  -- expect = optimistic version
--   sessions?: { upsert?: [record], delete?: [hash] },
--   keys?:     { upsert?: [record], delete?: [id] }
-- }
-- Returns { versions: { <account id>: <new version> } }. A version mismatch (another writer, e.g. the CLI, changed the row)
-- raises SQLSTATE 40001 and nothing is written.
CREATE FUNCTION knife_apply_core(change jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  item jsonb;
  v_doc jsonb;
  v_id text;
  new_version bigint;
  versions jsonb := '{}'::jsonb;
  touched jsonb := '[]'::jsonb;
BEGIN
  IF change ? 'defaultAccountId' THEN
    INSERT INTO instance_settings (key, value) VALUES ('defaultAccountId', change -> 'defaultAccountId')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = instance_settings.version + 1, updated_at = now()
    WHERE instance_settings.value IS DISTINCT FROM EXCLUDED.value;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(change -> 'accounts' -> 'upsert', '[]'::jsonb)) LOOP
    v_doc := item -> 'doc';
    v_id := v_doc ->> 'id';
    new_version := NULL;
    IF item ->> 'expect' IS NULL THEN
      INSERT INTO accounts (id, email, github_id, role, status, created_at, last_login_at, doc)
      VALUES (v_id, v_doc ->> 'email', (v_doc -> 'github' ->> 'id')::bigint, v_doc ->> 'role', v_doc ->> 'status',
        (v_doc ->> 'createdAt')::timestamptz, (v_doc ->> 'lastLoginAt')::timestamptz, v_doc - 'providerProfiles')
      ON CONFLICT (id) DO NOTHING
      RETURNING version INTO new_version;
    ELSE
      UPDATE accounts SET email = v_doc ->> 'email', github_id = (v_doc -> 'github' ->> 'id')::bigint, role = v_doc ->> 'role',
        status = v_doc ->> 'status', created_at = (v_doc ->> 'createdAt')::timestamptz,
        last_login_at = (v_doc ->> 'lastLoginAt')::timestamptz, doc = v_doc - 'providerProfiles',
        version = accounts.version + 1, updated_at = now()
      WHERE accounts.id = v_id AND accounts.version = (item ->> 'expect')::bigint
      RETURNING version INTO new_version;
    END IF;
    IF new_version IS NULL THEN
      RAISE EXCEPTION 'account % changed in the database (expected version %)', v_id, coalesce(item ->> 'expect', 'none')
        USING ERRCODE = '40001';
    END IF;
    DELETE FROM provider_profiles WHERE provider_profiles.account_id = v_id;
    INSERT INTO provider_profiles (account_id, id, position, name, config)
    SELECT v_id, p.value ->> 'id', p.ordinality::int - 1, p.value ->> 'name', p.value -> 'config'
    FROM jsonb_array_elements(coalesce(v_doc -> 'providerProfiles', '[]'::jsonb)) WITH ORDINALITY AS p(value, ordinality);
    versions := versions || jsonb_build_object(v_id, new_version::text);
    touched := touched || to_jsonb(v_id);
  END LOOP;

  INSERT INTO sessions (token_hash, account_id, pw_fingerprint, created_at, expires_at, last_seen_at)
  SELECT s ->> 'hash', s ->> 'accountId', s ->> 'pf', (s ->> 'createdAt')::timestamptz, (s ->> 'expiresAt')::timestamptz,
    (s ->> 'lastSeenAt')::timestamptz
  FROM jsonb_array_elements(coalesce(change -> 'sessions' -> 'upsert', '[]'::jsonb)) AS s
  ON CONFLICT (token_hash) DO UPDATE SET account_id = EXCLUDED.account_id, pw_fingerprint = EXCLUDED.pw_fingerprint,
    created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, last_seen_at = EXCLUDED.last_seen_at;
  DELETE FROM sessions WHERE token_hash IN (SELECT jsonb_array_elements_text(coalesce(change -> 'sessions' -> 'delete', '[]'::jsonb)));

  INSERT INTO mcp_keys (id, key_hash, account_id, name, hint, scope, created_at, last_used_at)
  SELECT k ->> 'id', k ->> 'hash', k ->> 'accountId', k ->> 'name', k ->> 'hint', k ->> 'scope', (k ->> 'createdAt')::timestamptz,
    (k ->> 'lastUsedAt')::timestamptz
  FROM jsonb_array_elements(coalesce(change -> 'keys' -> 'upsert', '[]'::jsonb)) AS k
  ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, account_id = EXCLUDED.account_id, name = EXCLUDED.name,
    hint = EXCLUDED.hint, scope = EXCLUDED.scope, created_at = EXCLUDED.created_at, last_used_at = EXCLUDED.last_used_at;
  DELETE FROM mcp_keys WHERE id IN (SELECT jsonb_array_elements_text(coalesce(change -> 'keys' -> 'delete', '[]'::jsonb)));

  -- Last: an account delete cascades to its profiles, sessions and keys.
  FOR item IN SELECT value FROM jsonb_array_elements(coalesce(change -> 'accounts' -> 'delete', '[]'::jsonb)) LOOP
    DELETE FROM accounts WHERE accounts.id = item ->> 'id' AND accounts.version = (item ->> 'expect')::bigint;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'account % changed in the database (expected version %)', item ->> 'id', item ->> 'expect'
        USING ERRCODE = '40001';
    END IF;
    touched := touched || to_jsonb(item ->> 'id');
  END LOOP;

  -- Other writers (the app instance, the CLI) reload what changed. Large batches (an import) say "all" instead of ids.
  IF jsonb_array_length(touched) > 0 OR change ? 'sessions' OR change ? 'keys' OR change ? 'defaultAccountId' THEN
  PERFORM pg_notify('knife_core', CASE WHEN jsonb_array_length(touched) > 200
    THEN jsonb_build_object('origin', change ->> 'origin', 'all', true)::text
    ELSE jsonb_build_object('origin', change ->> 'origin', 'accounts', touched,
      'sessions', change ? 'sessions', 'keys', change ? 'keys', 'settings', change ? 'defaultAccountId')::text END);
  END IF;
  RETURN jsonb_build_object('versions', versions);
END
$$;
