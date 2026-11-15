export interface Env {
	DB: D1Database
	/** Public client id the SDKs send as `client_id` (WORKOS_CLIENT_ID / VITE_PUBLIC_WORKOS_CLIENT_ID). */
	CLIENT_ID: string
	/** Externally visible origin of this Worker, e.g. https://humanlayer-auth.example.workers.dev. Used for `iss` and links. */
	PUBLIC_URL?: string
	/** Comma/whitespace separated redirect allowlist. Entries are exact URIs, or `<origin>/*` for any path on that origin. */
	ALLOWED_REDIRECT_URIS: string
	/** Comma separated emails allowed to self sign-up without an invitation. */
	SIGNUP_ALLOWED_EMAILS?: string
	/** Comma separated email domains allowed to self sign-up without an invitation. */
	SIGNUP_ALLOWED_DOMAINS?: string
	/** Allowed membership role slugs. */
	ROLE_SLUGS?: string
	ACCESS_TOKEN_TTL_SECONDS?: string
	REFRESH_TOKEN_TTL_SECONDS?: string
	/** Where the hosted invitation page sends a user once their account exists (the app's join/select page). */
	INVITATION_LANDING_URL?: string
	/** Optional: deliver signed organization_membership.* events here (the API's /webhooks/workos). */
	WEBHOOK_URL?: string

	// ---- secrets ----
	/** Bearer key the server SDKs use (WORKOS_API_KEY). */
	API_KEY: string
	/** RS256 private key as a JWK JSON string (must include `kid`). */
	SIGNING_KEY_JWK: string
	/** Optional previous public/private JWK still published in JWKS during a rotation. */
	SIGNING_KEY_JWK_PREVIOUS?: string
	WEBHOOK_SECRET?: string
}

export interface Config {
	clientId: string
	publicUrl: string
	redirectRules: RedirectRule[]
	signupEmails: Set<string>
	signupDomains: Set<string>
	roleSlugs: Set<string>
	accessTokenTtlSeconds: number
	refreshTokenTtlSeconds: number
	invitationLandingUrl: string | undefined
	secure: boolean
}

export type RedirectRule = { kind: 'exact'; uri: string } | { kind: 'origin'; origin: string }

function list(value: string | undefined): string[] {
	return (value ?? '')
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean)
}

function positiveInt(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(value ?? '', 10)
	return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadConfig(env: Env, requestUrl: URL): Config {
	const publicUrl = (env.PUBLIC_URL || requestUrl.origin).replace(/\/+$/, '')
	const redirectRules: RedirectRule[] = list(env.ALLOWED_REDIRECT_URIS).map((entry) => {
		if (entry.endsWith('/*')) return { kind: 'origin', origin: new URL(entry.slice(0, -2)).origin }
		return { kind: 'exact', uri: entry }
	})
	return {
		clientId: env.CLIENT_ID,
		publicUrl,
		redirectRules,
		signupEmails: new Set(list(env.SIGNUP_ALLOWED_EMAILS).map((e) => e.toLowerCase())),
		signupDomains: new Set(list(env.SIGNUP_ALLOWED_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, ''))),
		roleSlugs: new Set(list(env.ROLE_SLUGS || 'admin,member,manager')),
		accessTokenTtlSeconds: positiveInt(env.ACCESS_TOKEN_TTL_SECONDS, 3600),
		refreshTokenTtlSeconds: positiveInt(env.REFRESH_TOKEN_TTL_SECONDS, 30 * 24 * 3600),
		invitationLandingUrl: env.INVITATION_LANDING_URL || undefined,
		secure: new URL(publicUrl).protocol === 'https:',
	}
}

/** Exact-match or same-origin match against the allowlist. Never pattern-matches hosts. */
export function isAllowedRedirect(config: Config, candidate: string): boolean {
	let url: URL
	try {
		url = new URL(candidate)
	} catch {
		return false
	}
	if (url.username || url.password) return false
	for (const rule of config.redirectRules) {
		if (rule.kind === 'exact' && rule.uri === candidate) return true
		if (rule.kind === 'origin' && url.origin !== 'null' && url.origin === rule.origin) return true
	}
	return false
}

/** Origins (http/https only) allowed to call the token endpoint from a browser. */
export function isAllowedCorsOrigin(config: Config, origin: string): boolean {
	for (const rule of config.redirectRules) {
		const ruleOrigin = rule.kind === 'origin' ? rule.origin : safeOrigin(rule.uri)
		if (ruleOrigin && ruleOrigin !== 'null' && ruleOrigin === origin) return true
	}
	return false
}

function safeOrigin(uri: string): string | undefined {
	try {
		return new URL(uri).origin
	} catch {
		return undefined
	}
}
