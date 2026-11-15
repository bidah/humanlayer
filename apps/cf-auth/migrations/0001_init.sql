-- WorkOS-compatible auth service schema (D1 / SQLite).
-- Timestamps returned on the wire are ISO-8601 TEXT; expiry/bookkeeping columns are epoch-ms INTEGER.

CREATE TABLE users (
	id TEXT PRIMARY KEY,                 -- user_<ULID>
	email TEXT NOT NULL UNIQUE,          -- stored lower-cased
	email_verified INTEGER NOT NULL DEFAULT 0,
	first_name TEXT,
	last_name TEXT,
	password_hash TEXT,                  -- pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>
	external_id TEXT,
	metadata TEXT NOT NULL DEFAULT '{}',
	last_sign_in_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE organizations (
	id TEXT PRIMARY KEY,                 -- org_<ULID>
	name TEXT NOT NULL,
	external_id TEXT,
	stripe_customer_id TEXT,
	metadata TEXT NOT NULL DEFAULT '{}', -- JSON object; metadata.internal_org_id becomes the internal_org_id claim
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE organization_domains (
	id TEXT PRIMARY KEY,                 -- org_domain_<ULID>
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	domain TEXT NOT NULL UNIQUE,
	state TEXT NOT NULL,                 -- pending | verified | failed
	verification_strategy TEXT NOT NULL,
	verification_token TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX organization_domains_org ON organization_domains(organization_id);

CREATE TABLE organization_memberships (
	id TEXT PRIMARY KEY,                 -- om_<ULID>
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	role_slug TEXT NOT NULL,
	status TEXT NOT NULL,                -- active | inactive | pending
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, organization_id)
);
CREATE INDEX organization_memberships_org ON organization_memberships(organization_id, id);

CREATE TABLE invitations (
	id TEXT PRIMARY KEY,                 -- invitation_<ULID>
	email TEXT NOT NULL,
	organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
	inviter_user_id TEXT,
	accepted_user_id TEXT,
	role_slug TEXT,
	token TEXT NOT NULL UNIQUE,          -- returned by the WorkOS API in invitation objects, so stored as-is
	state TEXT NOT NULL,                 -- pending | accepted | revoked (expired is derived)
	expires_at TEXT NOT NULL,
	accepted_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX invitations_email ON invitations(email);
CREATE INDEX invitations_org ON invitations(organization_id, id);

-- Hosted-page browser session (cookie on the auth origin), so authorize/device pages need no re-entry of the password.
CREATE TABLE browser_sessions (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER
);

-- Application session (the `sid` claim). Refresh tokens hang off it.
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,                 -- session_<ULID>
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	client_id TEXT NOT NULL,
	organization_id TEXT,
	browser_session_id TEXT,
	auth_method TEXT NOT NULL,
	status TEXT NOT NULL,                -- active | ended | revoked
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	ended_at INTEGER
);
CREATE INDEX sessions_browser ON sessions(browser_session_id);

CREATE TABLE refresh_tokens (
	token_hash TEXT PRIMARY KEY,         -- SHA-256 of the opaque token
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER                      -- set on rotation; presenting a used token revokes the session
);
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);

CREATE TABLE authorization_codes (
	code_hash TEXT PRIMARY KEY,
	client_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id TEXT,
	browser_session_id TEXT,
	redirect_uri TEXT NOT NULL,
	code_challenge TEXT,
	code_challenge_method TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER,
	session_id TEXT                      -- set on exchange, revoked if the code is replayed
);

CREATE TABLE device_codes (
	device_code_hash TEXT PRIMARY KEY,
	user_code TEXT NOT NULL UNIQUE,
	client_id TEXT NOT NULL,
	status TEXT NOT NULL,                -- pending | approved | denied | consumed
	user_id TEXT,
	organization_id TEXT,
	browser_session_id TEXT,
	interval_seconds INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_poll_at INTEGER
);

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,                 -- api_key_<ULID>
	value_hash TEXT NOT NULL UNIQUE,     -- SHA-256 of the secret value
	obfuscated_value TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	permissions TEXT NOT NULL DEFAULT '[]',
	expires_at TEXT,
	last_used_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX api_keys_user ON api_keys(user_id, organization_id, id);

-- Fixed-window failure counters for password attempts (per email and per client IP).
CREATE TABLE auth_attempts (
	key TEXT PRIMARY KEY,
	window_start INTEGER NOT NULL,
	failures INTEGER NOT NULL
);
