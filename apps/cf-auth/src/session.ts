// Browser-facing primitives: CSRF, the hosted-page browser session cookie, password attempts.
import { getUser, type UserRow } from './db'
import type { Config, Env } from './env'
import { burnPasswordCheck, MAX_PASSWORD_LENGTH, verifyPassword } from './password'
import { cookie, newId, nowIso, parseCookies, randomToken, secretEqual, sha256b64 } from './util'

const BROWSER_SESSION_TTL_SECONDS = 14 * 24 * 3600
const CSRF_TTL_SECONDS = 2 * 3600

const csrfCookieName = (config: Config) => (config.secure ? '__Host-hl_csrf' : 'hl_csrf')
const sessionCookieName = (config: Config) => (config.secure ? '__Host-hl_session' : 'hl_session')

/** Double-submit CSRF token: reuse the cookie's value if present, else mint one and set it. */
export function csrfToken(req: Request, config: Config): { token: string; setCookie?: string } {
	const existing = parseCookies(req.headers.get('cookie')).get(csrfCookieName(config))
	if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return { token: existing }
	const token = randomToken(32)
	return {
		token,
		setCookie: cookie(csrfCookieName(config), token, {
			secure: config.secure,
			maxAge: CSRF_TTL_SECONDS,
			sameSite: 'Strict',
		}),
	}
}

/** Same-origin POST with a form token matching the CSRF cookie. */
export async function verifyCsrf(req: Request, config: Config, form: FormData): Promise<boolean> {
	const origin = req.headers.get('origin')
	if (origin !== null && origin !== new URL(config.publicUrl).origin) return false
	const fetchSite = req.headers.get('sec-fetch-site')
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
	const fromCookie = parseCookies(req.headers.get('cookie')).get(csrfCookieName(config))
	const fromForm = form.get('csrf_token')
	if (!fromCookie || typeof fromForm !== 'string' || !fromForm) return false
	return secretEqual(fromCookie, fromForm)
}

export interface BrowserSession {
	id: string
	user: UserRow
}

export async function getBrowserSession(req: Request, env: Env, config: Config): Promise<BrowserSession | null> {
	const raw = parseCookies(req.headers.get('cookie')).get(sessionCookieName(config))
	if (!raw) return null
	const row = await env.DB.prepare(
		'SELECT id, user_id FROM browser_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
	)
		.bind(await sha256b64(raw), Date.now())
		.first<{ id: string; user_id: string }>()
	if (!row) return null
	const user = await getUser(env.DB, row.user_id)
	return user ? { id: row.id, user } : null
}

export async function startBrowserSession(
	env: Env,
	config: Config,
	userId: string,
): Promise<{ id: string; setCookie: string }> {
	const token = randomToken(32)
	const id = newId('browser_session')
	const now = Date.now()
	await env.DB.prepare(
		'INSERT INTO browser_sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
	)
		.bind(id, await sha256b64(token), userId, now, now + BROWSER_SESSION_TTL_SECONDS * 1000)
		.run()
	return {
		id,
		setCookie: cookie(sessionCookieName(config), token, {
			secure: config.secure,
			maxAge: BROWSER_SESSION_TTL_SECONDS,
			sameSite: 'Lax',
		}),
	}
}

export async function endBrowserSession(req: Request, env: Env, config: Config): Promise<string> {
	const raw = parseCookies(req.headers.get('cookie')).get(sessionCookieName(config))
	if (raw) {
		await env.DB.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
			.bind(Date.now(), await sha256b64(raw))
			.run()
	}
	return cookie(sessionCookieName(config), '', { secure: config.secure, maxAge: 0, sameSite: 'Lax' })
}

// ---- password attempts: fixed 15 minute windows, per email and per client IP ----

const WINDOW_MS = 15 * 60 * 1000
const EMAIL_LIMIT = 10
const IP_LIMIT = 50

function attemptKeys(req: Request, email: string): Array<[string, number]> {
	const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
	return [
		[`email:${email}`, EMAIL_LIMIT],
		[`ip:${ip}`, IP_LIMIT],
	]
}

async function isLimited(env: Env, keys: Array<[string, number]>): Promise<boolean> {
	const now = Date.now()
	for (const [key, limit] of keys) {
		const row = await env.DB.prepare('SELECT window_start, failures FROM auth_attempts WHERE key = ?')
			.bind(key)
			.first<{ window_start: number; failures: number }>()
		if (row && now - row.window_start < WINDOW_MS && row.failures >= limit) return true
	}
	return false
}

export async function recordFailure(env: Env, req: Request, email: string): Promise<void> {
	const now = Date.now()
	await env.DB.batch(
		attemptKeys(req, email).map(([key]) =>
			env.DB.prepare(
				`INSERT INTO auth_attempts (key, window_start, failures) VALUES (?1, ?2, 1)
				 ON CONFLICT(key) DO UPDATE SET
				   failures = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
				   window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
			).bind(key, now, WINDOW_MS),
		),
	)
}

export type PasswordCheck = { ok: true; user: UserRow } | { ok: false; status: 401 | 429; message: string }

export const INVALID_CREDENTIALS = 'Invalid email or password.'
export const TOO_MANY_ATTEMPTS = 'Too many sign-in attempts. Wait 15 minutes and try again.'

/** Verifies a password with rate limiting and without revealing whether the email exists. */
export async function checkPassword(env: Env, req: Request, email: string, password: string): Promise<PasswordCheck> {
	if (await isLimited(env, attemptKeys(req, email))) return { ok: false, status: 429, message: TOO_MANY_ATTEMPTS }
	if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, status: 401, message: INVALID_CREDENTIALS }
	const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()
	let valid = false
	if (user?.password_hash) valid = await verifyPassword(password, user.password_hash)
	else await burnPasswordCheck(password)
	if (!user || !valid) {
		await recordFailure(env, req, email)
		return { ok: false, status: 401, message: INVALID_CREDENTIALS }
	}
	await env.DB.batch([
		env.DB.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(`email:${email}`),
		env.DB.prepare('UPDATE users SET last_sign_in_at = ?, updated_at = updated_at WHERE id = ?').bind(
			nowIso(),
			user.id,
		),
	])
	return { ok: true, user }
}
