// Hosted AuthKit-compatible flows: /user_management/authorize (PKCE), /user_management/authenticate
// (code, refresh_token and device_code grants), device authorization, logout and invitation pages.
import {
	activeMemberships,
	getUser,
	getUserByEmail,
	type InvitationRow,
	invitationState,
	type MembershipRow,
	type UserRow,
	acceptInvitationUrl,
} from './db'
import { type Config, type Env, isAllowedRedirect } from './env'
import { acceptInvitationRow } from './management'
import { credentialsForm, continueForm, esc, messagePage, page, type OrgChoice } from './pages'
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password'
import {
	checkPassword,
	csrfToken,
	endBrowserSession,
	getBrowserSession,
	recordFailure,
	startBrowserSession,
	verifyCsrf,
} from './session'
import { createSession, issueTokens, revokeSession, type SessionRow } from './tokens'
import {
	ApiError,
	base64url,
	EMAIL_RE,
	json,
	newId,
	normalizeEmail,
	nowIso,
	oauthError,
	randomToken,
	secretEqual,
	sha256,
	sha256b64,
} from './util'

type Ctx = { env: Env; ctx: ExecutionContext; config: Config; req: Request; url: URL }

const AUTH_CODE_TTL_MS = 5 * 60 * 1000
const DEVICE_CODE_TTL_SECONDS = 600
const DEVICE_POLL_INTERVAL_SECONDS = 5
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

function withHeaders(res: Response, headers: Array<[string, string] | undefined>): Response {
	for (const h of headers) if (h) res.headers.append(h[0], h[1])
	return res
}
const setCookieHeader = (value: string | undefined): [string, string] | undefined =>
	value ? ['set-cookie', value] : undefined

function redirect(location: string, status = 303, cookies: Array<string | undefined> = []): Response {
	const headers = new Headers({ location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
	for (const c of cookies) if (c) headers.append('set-cookie', c)
	return new Response(null, { status, headers })
}

// ---------------------------------------------------------------------------------------------
// Sign-up policy
// ---------------------------------------------------------------------------------------------

async function pendingInvitationsFor(env: Env, email: string): Promise<InvitationRow[]> {
	const { results } = await env.DB.prepare("SELECT * FROM invitations WHERE email = ? AND state = 'pending'")
		.bind(email)
		.all<InvitationRow>()
	return results.filter((row) => invitationState(row) === 'pending')
}

export async function findInvitationByToken(env: Env, token: string | undefined): Promise<InvitationRow | null> {
	if (!token) return null
	return env.DB.prepare('SELECT * FROM invitations WHERE token = ?').bind(token).first<InvitationRow>()
}

function signupAllowlisted(config: Config, email: string): boolean {
	const domain = email.split('@')[1] ?? ''
	return config.signupEmails.has(email) || config.signupDomains.has(domain)
}

type SignUpResult = { ok: true; user: UserRow } | { ok: false; status: number; message: string }

async function signUp(
	{ env, config, req }: Ctx,
	form: FormData,
	invitation: InvitationRow | null,
): Promise<SignUpResult> {
	const email = normalizeEmail(field(form, 'email'))
	const password = field(form, 'password')
	if (!EMAIL_RE.test(email) || email.length > 320)
		return { ok: false, status: 400, message: 'Enter a valid email address.' }
	if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		return {
			ok: false,
			status: 400,
			message: `Passwords must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.`,
		}
	}
	if (invitation && invitation.email !== email) {
		return { ok: false, status: 400, message: 'This invitation was sent to a different email address.' }
	}
	const invited = invitation
		? invitationState(invitation) === 'pending'
		: (await pendingInvitationsFor(env, email)).length > 0
	// Eligibility is checked before existence, so non-eligible callers learn nothing about which accounts exist.
	if (!invited && !signupAllowlisted(config, email)) {
		await recordFailure(env, req, email)
		return {
			ok: false,
			status: 403,
			message: 'Sign-up is by invitation only. Ask an organization admin to invite this email address.',
		}
	}
	if (await getUserByEmail(env.DB, email)) {
		return { ok: false, status: 409, message: 'An account with this email already exists. Sign in instead.' }
	}
	const now = nowIso()
	const id = newId('user')
	const first = field(form, 'first_name').trim().slice(0, 100) || null
	const last = field(form, 'last_name').trim().slice(0, 100) || null
	await env.DB.prepare(
		'INSERT INTO users (id, email, email_verified, first_name, last_name, password_hash, metadata, last_sign_in_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(id, email, invited ? 1 : 0, first, last, await hashPassword(password), '{}', now, now, now)
		.run()
	const user = await getUser(env.DB, id)
	if (!user) throw new ApiError(500, { message: 'Internal server error.' })
	return { ok: true, user }
}

/** Handles a sign_in / sign_up form post. On success starts the browser session. */
async function authenticateForm(
	c: Ctx,
	form: FormData,
	invitation: InvitationRow | null,
): Promise<
	| { ok: true; user: UserRow; browserSessionId: string; setCookie: string }
	| { ok: false; status: number; message: string }
> {
	const intent = form.get('intent')
	let user: UserRow
	if (intent === 'sign_up') {
		const result = await signUp(c, form, invitation)
		if (!result.ok) return result
		user = result.user
	} else {
		const email = normalizeEmail(field(form, 'email'))
		const result = await checkPassword(c.env, c.req, email, field(form, 'password'))
		if (!result.ok) return result
		user = result.user
	}
	if (invitation && invitation.email === user.email && invitationState(invitation) === 'pending') {
		await acceptInvitationRow(c.env, c.ctx, invitation, user)
	}
	const started = await startBrowserSession(c.env, c.config, user.id)
	return { ok: true, user, browserSessionId: started.id, setCookie: started.setCookie }
}

/** A text form field ('' when absent or a file). */
function field(form: FormData, name: string): string {
	const value = form.get(name)
	return typeof value === 'string' ? value : ''
}

async function readForm(req: Request): Promise<FormData | null> {
	const type = req.headers.get('content-type') ?? ''
	if (!type.startsWith('application/x-www-form-urlencoded') && !type.startsWith('multipart/form-data')) return null
	try {
		return await req.formData()
	} catch {
		return null
	}
}

const csrfFailure = () =>
	messagePage(
		'Request expired',
		'Your form expired or was submitted from another site. Go back, reload the page and try again.',
		403,
	)

// ---------------------------------------------------------------------------------------------
// /user_management/authorize
// ---------------------------------------------------------------------------------------------

const AUTHORIZE_FIELDS = [
	'client_id',
	'redirect_uri',
	'response_type',
	'state',
	'code_challenge',
	'code_challenge_method',
	'organization_id',
	'screen_hint',
	'login_hint',
	'invitation_token',
	'provider',
] as const
type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_FIELDS)[number], string>>

function readAuthorizeParams(source: URLSearchParams | FormData): AuthorizeParams {
	const out: AuthorizeParams = {}
	for (const key of AUTHORIZE_FIELDS) {
		const value = source.get(key)
		if (typeof value === 'string' && value !== '') out[key] = value
	}
	return out
}

function validateAuthorize(config: Config, p: AuthorizeParams): string | null {
	if (p.client_id !== config.clientId) return 'Unknown client_id.'
	if (!p.redirect_uri || !isAllowedRedirect(config, p.redirect_uri))
		return 'The redirect_uri is not on this service’s allowlist.'
	if (p.response_type !== 'code') return 'response_type must be "code".'
	if (p.provider && p.provider !== 'authkit')
		return `Provider "${p.provider}" is not supported; only email and password sign-in is available.`
	if (!p.code_challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge))
		return 'A PKCE code_challenge is required.'
	if (p.code_challenge_method !== 'S256') return 'code_challenge_method must be S256.'
	if (p.state && p.state.length > 4096) return 'state is too long.'
	return null
}

function authorizeUrl(params: AuthorizeParams, overrides: AuthorizeParams = {}): string {
	const q = new URLSearchParams()
	for (const [k, v] of Object.entries({ ...params, ...overrides })) if (v) q.set(k, v)
	return `/user_management/authorize?${q.toString()}`
}

const orgChoices = (memberships: MembershipRow[]): OrgChoice[] =>
	memberships.map((m) => ({ id: m.organization_id, name: m.organization_name ?? m.organization_id }))

async function renderAuthorize(
	c: Ctx,
	p: AuthorizeParams,
	opts: { error?: string; status?: number; email?: string; mode?: 'sign_in' | 'sign_up' } = {},
) {
	const { config, req, env } = c
	const csrf = csrfToken(req, config)
	const session = await getBrowserSession(req, env, config)
	const hiddenFields = p as Record<string, string | undefined>
	if (session) {
		const memberships = await activeMemberships(env.DB, session.user.id)
		const res = page(
			'Continue',
			continueForm({
				action: '/user_management/authorize',
				csrf: csrf.token,
				email: session.user.email,
				hiddenFields,
				organizations: p.organization_id ? undefined : orgChoices(memberships),
				heading: 'Continue to HumanLayer',
				submitLabel: 'Continue',
				error: opts.error,
				switchAccountUrl: `/session/switch?return_to=${encodeURIComponent(authorizeUrl(p))}`,
			}),
			opts.status ?? 200,
		)
		return withHeaders(res, [setCookieHeader(csrf.setCookie)])
	}
	const invitation = await findInvitationByToken(env, p.invitation_token)
	const mode = opts.mode ?? (p.screen_hint === 'sign-up' || invitation ? 'sign_up' : 'sign_in')
	const res = page(
		mode === 'sign_up' ? 'Create account' : 'Sign in',
		credentialsForm({
			action: '/user_management/authorize',
			mode,
			csrf: csrf.token,
			hiddenFields,
			email: opts.email ?? invitation?.email ?? p.login_hint,
			emailLocked: Boolean(invitation && mode === 'sign_up'),
			error: opts.error,
			switchUrl: authorizeUrl(p, { screen_hint: mode === 'sign_up' ? 'sign-in' : 'sign-up' }),
		}),
		opts.status ?? 200,
	)
	return withHeaders(res, [setCookieHeader(csrf.setCookie)])
}

export async function authorizeGet(c: Ctx): Promise<Response> {
	const p = readAuthorizeParams(c.url.searchParams)
	const error = validateAuthorize(c.config, p)
	// Never redirect on an invalid client or redirect_uri: that is how open redirects happen.
	if (error) return messagePage('Cannot sign in', error, 400)
	return renderAuthorize(c, p)
}

async function issueAuthorizationCode(
	c: Ctx,
	p: AuthorizeParams,
	user: UserRow,
	organizationId: string | null,
	browserSessionId: string,
	cookies: Array<string | undefined>,
): Promise<Response> {
	const code = randomToken(32)
	const now = Date.now()
	await c.env.DB.prepare(
		'INSERT INTO authorization_codes (code_hash, client_id, user_id, organization_id, browser_session_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(
			await sha256b64(code),
			p.client_id,
			user.id,
			organizationId,
			browserSessionId,
			p.redirect_uri,
			p.code_challenge,
			p.code_challenge_method,
			now,
			now + AUTH_CODE_TTL_MS,
		)
		.run()
	if (!p.redirect_uri) return messagePage('Cannot sign in', 'redirect_uri is required.', 400)
	const target = new URL(p.redirect_uri)
	target.searchParams.set('code', code)
	if (p.state) target.searchParams.set('state', p.state)
	return redirect(target.toString(), 303, cookies)
}

/** Resolve the organization for this sign-in: requested, chosen, the only one, or a picker. */
async function resolveOrganization(
	env: Env,
	user: UserRow,
	requested: string | undefined,
	chosen: string | undefined,
): Promise<
	{ kind: 'org'; id: string | null } | { kind: 'pick'; memberships: MembershipRow[] } | { kind: 'forbidden' }
> {
	const memberships = await activeMemberships(env.DB, user.id)
	const target = requested ?? chosen
	if (target)
		return memberships.some((m) => m.organization_id === target)
			? { kind: 'org', id: target }
			: { kind: 'forbidden' }
	if (memberships.length === 0) return { kind: 'org', id: null }
	const only = memberships[0]
	if (memberships.length === 1 && only) return { kind: 'org', id: only.organization_id }
	return { kind: 'pick', memberships }
}

export async function authorizePost(c: Ctx): Promise<Response> {
	const form = await readForm(c.req)
	if (!form) return messagePage('Bad request', 'Expected a form submission.', 400)
	if (!(await verifyCsrf(c.req, c.config, form))) return csrfFailure()
	const p = readAuthorizeParams(form)
	const error = validateAuthorize(c.config, p)
	if (error) return messagePage('Cannot sign in', error, 400)

	const intent = form.get('intent')
	let user: UserRow
	let browserSessionId: string
	let setCookie: string | undefined
	if (intent === 'sign_in' || intent === 'sign_up') {
		const invitation = await findInvitationByToken(c.env, p.invitation_token)
		const result = await authenticateForm(c, form, invitation)
		if (!result.ok) {
			return renderAuthorize(c, p, {
				error: result.message,
				status: result.status,
				email: field(form, 'email'),
				mode: intent,
			})
		}
		;({ user, browserSessionId, setCookie } = result)
	} else if (intent === 'continue') {
		const session = await getBrowserSession(c.req, c.env, c.config)
		if (!session) return renderAuthorize(c, p, { error: 'Your session ended. Sign in again.', status: 401 })
		user = session.user
		browserSessionId = session.id
	} else {
		return messagePage('Bad request', 'Unknown action.', 400)
	}

	const choice = form.get('organization_choice')
	const org = await resolveOrganization(
		c.env,
		user,
		p.organization_id,
		typeof choice === 'string' ? choice : undefined,
	)
	if (org.kind === 'forbidden') {
		const csrf = csrfToken(c.req, c.config)
		return withHeaders(
			page(
				'Not a member',
				`<h1>Not a member</h1><p>${esc(user.email)} is not an active member of the requested organization.</p><form method="post" action="/session/switch?return_to=${esc(encodeURIComponent(authorizeUrl(p)))}"><input type="hidden" name="csrf_token" value="${esc(csrf.token)}"><button type="submit" class="secondary">Use a different account</button></form>`,
				403,
			),
			[setCookieHeader(setCookie), setCookieHeader(csrf.setCookie)],
		)
	}
	if (org.kind === 'pick') {
		const csrf = csrfToken(c.req, c.config)
		return withHeaders(
			page(
				'Choose organization',
				continueForm({
					action: '/user_management/authorize',
					csrf: csrf.token,
					email: user.email,
					hiddenFields: p as Record<string, string | undefined>,
					organizations: orgChoices(org.memberships),
					heading: 'Choose an organization',
					submitLabel: 'Continue',
					switchAccountUrl: `/session/switch?return_to=${encodeURIComponent(authorizeUrl(p))}`,
				}),
			),
			[setCookieHeader(setCookie), setCookieHeader(csrf.setCookie)],
		)
	}
	return issueAuthorizationCode(c, p, user, org.id, browserSessionId, [setCookie])
}

/** POST /session/switch: drop the hosted browser session and return to a local page. */
export async function switchAccount(c: Ctx): Promise<Response> {
	const form = await readForm(c.req)
	if (!form || !(await verifyCsrf(c.req, c.config, form))) return csrfFailure()
	const cleared = await endBrowserSession(c.req, c.env, c.config)
	const returnTo = c.url.searchParams.get('return_to') ?? '/'
	const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('\\') ? returnTo : '/'
	return redirect(safe, 303, [cleared])
}

// ---------------------------------------------------------------------------------------------
// /user_management/authenticate
// ---------------------------------------------------------------------------------------------

async function readBody(req: Request): Promise<Record<string, string>> {
	const type = req.headers.get('content-type') ?? ''
	const out: Record<string, string> = {}
	if (type.includes('application/json')) {
		let parsed: unknown
		try {
			parsed = await req.json()
		} catch {
			throw oauthError(400, 'invalid_request', 'Malformed JSON body.')
		}
		if (parsed && typeof parsed === 'object') {
			for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
		}
		return out
	}
	const form = await readForm(req)
	if (!form) throw oauthError(400, 'invalid_request', 'Unsupported content type.')
	for (const [k, v] of form) if (typeof v === 'string') out[k] = v
	return out
}

async function sessionUser(env: Env, session: SessionRow): Promise<UserRow> {
	const user = await getUser(env.DB, session.user_id)
	if (!user) throw oauthError(400, 'invalid_grant', 'The user no longer exists.')
	return user
}

async function exchangeCode(c: Ctx, body: Record<string, string>, confidential: boolean) {
	const { env, config } = c
	if (!body.code) throw oauthError(400, 'invalid_request', 'code is required.')
	const codeHash = await sha256b64(body.code)
	const now = Date.now()
	// Single use: the UPDATE only succeeds for an unused code.
	const row = await env.DB.prepare(
		'UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING *',
	)
		.bind(now, codeHash)
		.first<{
			client_id: string
			user_id: string
			organization_id: string | null
			browser_session_id: string | null
			code_challenge: string | null
			expires_at: number
		}>()
	if (!row) {
		const replay = await env.DB.prepare('SELECT session_id FROM authorization_codes WHERE code_hash = ?')
			.bind(codeHash)
			.first<{ session_id: string | null }>()
		// A replayed code revokes whatever was issued from it (RFC 6749 §4.1.2).
		if (replay?.session_id) await revokeSession(env, replay.session_id, 'revoked')
		throw oauthError(400, 'invalid_grant', replay ? 'The code has already been used.' : 'The code is invalid.')
	}
	if (row.expires_at <= now) throw oauthError(400, 'invalid_grant', 'The code has expired.')
	if (row.client_id !== body.client_id)
		throw oauthError(400, 'invalid_grant', 'The code was issued to another client.')
	if (row.code_challenge) {
		if (!body.code_verifier) throw oauthError(400, 'invalid_grant', 'code_verifier is required.')
		const computed = base64url(await sha256(body.code_verifier))
		if (!(await secretEqual(computed, row.code_challenge)))
			throw oauthError(400, 'invalid_grant', 'PKCE verification failed.')
	} else if (!confidential) {
		throw oauthError(400, 'invalid_grant', 'This code requires client authentication.')
	}
	const user = await getUser(env.DB, row.user_id)
	if (!user) throw oauthError(400, 'invalid_grant', 'The user no longer exists.')
	const session = await createSession(env, config, {
		userId: user.id,
		organizationId: row.organization_id,
		browserSessionId: row.browser_session_id,
	})
	await env.DB.prepare('UPDATE authorization_codes SET session_id = ? WHERE code_hash = ?')
		.bind(session.id, codeHash)
		.run()
	return issueTokens(env, config, session, user)
}

async function refresh(c: Ctx, body: Record<string, string>) {
	const { env, config } = c
	if (!body.refresh_token) throw oauthError(400, 'invalid_request', 'refresh_token is required.')
	const hash = await sha256b64(body.refresh_token)
	const now = Date.now()
	const token = await env.DB.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
		.bind(hash)
		.first<{ session_id: string; expires_at: number; used_at: number | null }>()
	if (!token) throw oauthError(400, 'invalid_grant', 'Invalid refresh token.')
	if (token.used_at !== null) {
		// Reuse of a rotated token: treat the session as compromised.
		await revokeSession(env, token.session_id, 'revoked')
		throw oauthError(400, 'invalid_grant', 'Refresh token already exchanged.')
	}
	if (token.expires_at <= now) throw oauthError(400, 'invalid_grant', 'Refresh token expired.')
	const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
		.bind(token.session_id)
		.first<SessionRow>()
	if (!session || session.status !== 'active' || session.expires_at <= now)
		throw oauthError(400, 'invalid_grant', 'Session has ended.')
	if (session.client_id !== body.client_id)
		throw oauthError(400, 'invalid_grant', 'Refresh token was issued to another client.')
	const user = await sessionUser(env, session)

	let organizationId = session.organization_id
	const memberships = await activeMemberships(env.DB, user.id)
	if (body.organization_id) {
		if (!memberships.some((m) => m.organization_id === body.organization_id)) {
			throw oauthError(400, 'invalid_grant', 'The user is not an active member of that organization.')
		}
		organizationId = body.organization_id
	} else if (organizationId && !memberships.some((m) => m.organization_id === organizationId)) {
		organizationId = null // membership removed: keep the session, drop the org scope
	}

	const burned = await env.DB.prepare(
		'UPDATE refresh_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
	)
		.bind(now, hash)
		.run()
	if (!burned.meta.changes) {
		await revokeSession(env, token.session_id, 'revoked')
		throw oauthError(400, 'invalid_grant', 'Refresh token already exchanged.')
	}
	if (organizationId !== session.organization_id) {
		await env.DB.prepare('UPDATE sessions SET organization_id = ? WHERE id = ?')
			.bind(organizationId, session.id)
			.run()
	}
	return issueTokens(env, config, { ...session, organization_id: organizationId }, user)
}

async function pollDevice(c: Ctx, body: Record<string, string>) {
	const { env, config } = c
	if (!body.device_code) throw oauthError(400, 'invalid_request', 'device_code is required.')
	const hash = await sha256b64(body.device_code)
	const row = await env.DB.prepare('SELECT * FROM device_codes WHERE device_code_hash = ?').bind(hash).first<{
		client_id: string
		status: string
		user_id: string | null
		organization_id: string | null
		browser_session_id: string | null
		interval_seconds: number
		expires_at: number
		last_poll_at: number | null
	}>()
	const now = Date.now()
	if (!row || row.client_id !== body.client_id) throw oauthError(400, 'invalid_grant', 'Invalid device code.')
	if (row.status === 'consumed') throw oauthError(400, 'invalid_grant', 'The device code has already been used.')
	if (row.expires_at <= now) throw oauthError(400, 'expired_token', 'The device code has expired.')
	if (row.status === 'denied') throw oauthError(400, 'access_denied', 'The user denied the request.')
	if (row.status === 'pending') {
		const tooFast = row.last_poll_at !== null && now - row.last_poll_at < row.interval_seconds * 1000 - 1000
		await env.DB.prepare('UPDATE device_codes SET last_poll_at = ? WHERE device_code_hash = ?')
			.bind(now, hash)
			.run()
		if (tooFast) throw oauthError(400, 'slow_down', 'Polling too frequently.')
		throw oauthError(400, 'authorization_pending', 'The user has not yet completed authorization.')
	}
	const claimed = await env.DB.prepare(
		"UPDATE device_codes SET status = 'consumed' WHERE device_code_hash = ? AND status = 'approved'",
	)
		.bind(hash)
		.run()
	if (!claimed.meta.changes || !row.user_id)
		throw oauthError(400, 'invalid_grant', 'The device code has already been used.')
	const user = await getUser(env.DB, row.user_id)
	if (!user) throw oauthError(400, 'invalid_grant', 'The user no longer exists.')
	const session = await createSession(env, config, {
		userId: user.id,
		organizationId: row.organization_id,
		browserSessionId: row.browser_session_id,
	})
	return issueTokens(env, config, session, user)
}

export async function authenticate(c: Ctx): Promise<Response> {
	const body = await readBody(c.req)
	if (body.client_id !== c.config.clientId) throw oauthError(400, 'invalid_client', 'Invalid client ID.')
	let confidential = false
	if (body.client_secret !== undefined) {
		if (!(await secretEqual(body.client_secret, c.env.API_KEY)))
			throw oauthError(401, 'invalid_client', 'Invalid client secret.')
		confidential = true
	}
	switch (body.grant_type) {
		case 'authorization_code':
			return json(await exchangeCode(c, body, confidential))
		case 'refresh_token':
			return json(await refresh(c, body))
		case 'urn:ietf:params:oauth:grant-type:device_code':
			return json(await pollDevice(c, body))
		default:
			throw oauthError(400, 'unsupported_grant_type', `Unsupported grant_type: ${body.grant_type ?? '(none)'}.`)
	}
}

// ---------------------------------------------------------------------------------------------
// Device authorization (RFC 8628) as WorkOS exposes it
// ---------------------------------------------------------------------------------------------

function newUserCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	let out = ''
	for (const b of bytes) out += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]
	return `${out.slice(0, 4)}-${out.slice(4)}`
}

const normalizeUserCode = (input: string) => {
	const raw = input.toUpperCase().replace(/[^A-Z]/g, '')
	return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null
}

export async function deviceAuthorize(c: Ctx): Promise<Response> {
	const body = await readBody(c.req)
	if (body.client_id !== c.config.clientId) throw oauthError(400, 'invalid_client', 'Invalid client ID.')
	const deviceCode = randomToken(32)
	const now = Date.now()
	for (let attempt = 0; attempt < 5; attempt++) {
		const userCode = newUserCode()
		try {
			await c.env.DB.prepare(
				"INSERT INTO device_codes (device_code_hash, user_code, client_id, status, interval_seconds, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
			)
				.bind(
					await sha256b64(deviceCode),
					userCode,
					body.client_id,
					DEVICE_POLL_INTERVAL_SECONDS,
					now,
					now + DEVICE_CODE_TTL_SECONDS * 1000,
				)
				.run()
		} catch {
			continue // user_code collision; retry
		}
		const verificationUri = `${c.config.publicUrl}/device`
		return json({
			device_code: deviceCode,
			user_code: userCode,
			verification_uri: verificationUri,
			verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
			expires_in: DEVICE_CODE_TTL_SECONDS,
			interval: DEVICE_POLL_INTERVAL_SECONDS,
		})
	}
	throw new ApiError(500, { message: 'Could not allocate a device code.' })
}

async function pendingDevice(env: Env, userCode: string | null) {
	if (!userCode) return null
	const row = await env.DB.prepare(
		"SELECT user_code, expires_at FROM device_codes WHERE user_code = ? AND status = 'pending'",
	)
		.bind(userCode)
		.first<{ user_code: string; expires_at: number }>()
	return row && row.expires_at > Date.now() ? row : null
}

async function renderDevice(
	c: Ctx,
	opts: { userCode: string | null; error?: string; status?: number; email?: string },
): Promise<Response> {
	const { env, config, req } = c
	const csrf = csrfToken(req, config)
	const session = await getBrowserSession(req, env, config)
	const hiddenFields = { user_code: opts.userCode ?? undefined }
	let inner: string
	if (!session) {
		inner = credentialsForm({
			action: '/device',
			mode: 'sign_in',
			csrf: csrf.token,
			hiddenFields,
			email: opts.email,
			error: opts.error,
			heading: 'Sign in to connect a device',
			subheading: opts.userCode ? `Device code ${opts.userCode}` : 'HumanLayer CLI',
		})
	} else if (!(await pendingDevice(env, opts.userCode))) {
		inner = `<h1>Connect a device</h1><p>Enter the code shown in your terminal.</p>${opts.error ? `<div class="error" role="alert">${esc(opts.error)}</div>` : ''}
<form method="get" action="/device"><label for="user_code">Device code</label><input id="user_code" name="user_code" type="text" autocomplete="off" required placeholder="XXXX-XXXX" maxlength="12"><button type="submit">Next</button></form>`
	} else {
		const memberships = await activeMemberships(env.DB, session.user.id)
		inner = `<div class="code">${esc(opts.userCode)}</div>${continueForm({
			action: '/device',
			csrf: csrf.token,
			email: session.user.email,
			hiddenFields,
			organizations: orgChoices(memberships),
			heading: 'Approve this device?',
			subheading: 'Only approve if this code matches the one in your terminal and you started this sign-in.',
			submitLabel: 'Approve',
			denyLabel: 'Deny',
			error: opts.error,
			switchAccountUrl: `/session/switch?return_to=${encodeURIComponent(`/device?user_code=${opts.userCode}`)}`,
		})}`
	}
	return withHeaders(page('Connect a device', inner, opts.status ?? 200), [setCookieHeader(csrf.setCookie)])
}

export async function deviceGet(c: Ctx): Promise<Response> {
	const raw = c.url.searchParams.get('user_code')
	const userCode = raw ? normalizeUserCode(raw) : null
	const error = raw && !(await pendingDevice(c.env, userCode)) ? 'That code is invalid or has expired.' : undefined
	return renderDevice(c, { userCode, error, status: error ? 400 : 200 })
}

export async function devicePost(c: Ctx): Promise<Response> {
	const form = await readForm(c.req)
	if (!form) return messagePage('Bad request', 'Expected a form submission.', 400)
	if (!(await verifyCsrf(c.req, c.config, form))) return csrfFailure()
	const userCode = normalizeUserCode(field(form, 'user_code'))
	const intent = form.get('intent')
	if (intent === 'sign_in') {
		const result = await authenticateForm(c, form, null)
		if (!result.ok)
			return renderDevice(c, {
				userCode,
				error: result.message,
				status: result.status,
				email: field(form, 'email'),
			})
		return redirect(userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : '/device', 303, [
			result.setCookie,
		])
	}
	const session = await getBrowserSession(c.req, c.env, c.config)
	if (!session) return renderDevice(c, { userCode, error: 'Your session ended. Sign in again.', status: 401 })
	if (!(await pendingDevice(c.env, userCode)))
		return renderDevice(c, { userCode: null, error: 'That code is invalid or has expired.', status: 400 })
	if (intent === 'deny') {
		await c.env.DB.prepare("UPDATE device_codes SET status = 'denied' WHERE user_code = ? AND status = 'pending'")
			.bind(userCode)
			.run()
		return messagePage('Request denied', 'The device was not signed in. You can close this window.')
	}
	if (intent !== 'continue') return messagePage('Bad request', 'Unknown action.', 400)
	const choice = form.get('organization_choice')
	const org = await resolveOrganization(
		c.env,
		session.user,
		undefined,
		typeof choice === 'string' ? choice : undefined,
	)
	if (org.kind !== 'org')
		return renderDevice(c, { userCode, error: 'Choose one of your organizations.', status: 400 })
	const updated = await c.env.DB.prepare(
		"UPDATE device_codes SET status = 'approved', user_id = ?, organization_id = ?, browser_session_id = ? WHERE user_code = ? AND status = 'pending'",
	)
		.bind(session.user.id, org.id, session.id, userCode)
		.run()
	if (!updated.meta.changes)
		return renderDevice(c, { userCode: null, error: 'That code is invalid or has expired.', status: 400 })
	return messagePage(
		'Device connected',
		'You are signed in on your device. You can close this window and return to the terminal.',
	)
}

// ---------------------------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------------------------

export async function logout(c: Ctx): Promise<Response> {
	const { env, config, req, url } = c
	const sessionId = url.searchParams.get('session_id')
	if (sessionId) {
		const session = await env.DB.prepare('SELECT browser_session_id FROM sessions WHERE id = ?')
			.bind(sessionId)
			.first<{ browser_session_id: string | null }>()
		if (session) {
			await revokeSession(env, sessionId, 'ended')
			if (session.browser_session_id) {
				await env.DB.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
					.bind(Date.now(), session.browser_session_id)
					.run()
			}
		}
	}
	const cleared = await endBrowserSession(req, env, config)
	const returnTo = url.searchParams.get('return_to')
	if (returnTo && isAllowedRedirect(config, returnTo)) return redirect(returnTo, 302, [cleared])
	return messagePage('Signed out', 'You have been signed out.', 200, { 'set-cookie': cleared })
}

// ---------------------------------------------------------------------------------------------
// Invitations (no email delivery: links are returned by the API and listed for org admins)
// ---------------------------------------------------------------------------------------------

function invitationDone(c: Ctx, user: UserRow, cookies: Array<string | undefined>): Response {
	const landing = c.config.invitationLandingUrl
	const res = page(
		'Invitation accepted',
		`<h1>You're in</h1><p>${esc(user.email)} has joined the organization.</p>${landing ? `<p class="links"><a href="${esc(landing)}">Continue to HumanLayer</a></p>` : '<p class="muted">You can close this window and sign in to HumanLayer.</p>'}`,
	)
	return withHeaders(res, cookies.map(setCookieHeader))
}

async function renderInvitation(
	c: Ctx,
	invitation: InvitationRow,
	opts: { error?: string; status?: number } = {},
): Promise<Response> {
	const csrf = csrfToken(c.req, c.config)
	const org = invitation.organization_id
		? await c.env.DB.prepare('SELECT name FROM organizations WHERE id = ?')
				.bind(invitation.organization_id)
				.first<{ name: string }>()
		: null
	const existing = await getUserByEmail(c.env.DB, invitation.email)
	const inner = credentialsForm({
		action: '/invitations/accept',
		mode: existing ? 'sign_in' : 'sign_up',
		csrf: csrf.token,
		hiddenFields: { invitation_token: invitation.token },
		email: invitation.email,
		emailLocked: true,
		error: opts.error,
		heading: org ? `Join ${org.name}` : 'Accept invitation',
		subheading: existing ? 'Sign in to accept this invitation.' : 'Create your account to accept this invitation.',
	})
	return withHeaders(page('Accept invitation', inner, opts.status ?? 200), [setCookieHeader(csrf.setCookie)])
}

export async function invitationGet(c: Ctx): Promise<Response> {
	const invitation = await findInvitationByToken(c.env, c.url.searchParams.get('invitation_token') ?? undefined)
	if (!invitation) return messagePage('Invitation not found', 'This invitation link is invalid.', 404)
	const state = invitationState(invitation)
	if (state !== 'pending')
		return messagePage(
			'Invitation unavailable',
			`This invitation has ${state === 'accepted' ? 'already been accepted' : `been ${state}`}.`,
			410,
		)
	const session = await getBrowserSession(c.req, c.env, c.config)
	if (session && session.user.email === invitation.email) {
		// Already signed in as the invitee: accepting still requires an explicit POST (CSRF-protected).
		const csrf = csrfToken(c.req, c.config)
		return withHeaders(
			page(
				'Accept invitation',
				`<h1>Accept invitation</h1><p>Signed in as <strong>${esc(session.user.email)}</strong>.</p><form method="post" action="/invitations/accept"><input type="hidden" name="csrf_token" value="${esc(csrf.token)}"><input type="hidden" name="invitation_token" value="${esc(invitation.token)}"><input type="hidden" name="intent" value="continue"><button type="submit">Accept invitation</button></form>`,
			),
			[setCookieHeader(csrf.setCookie)],
		)
	}
	return renderInvitation(c, invitation)
}

export async function invitationPost(c: Ctx): Promise<Response> {
	const form = await readForm(c.req)
	if (!form) return messagePage('Bad request', 'Expected a form submission.', 400)
	if (!(await verifyCsrf(c.req, c.config, form))) return csrfFailure()
	const invitation = await findInvitationByToken(c.env, field(form, 'invitation_token') || undefined)
	if (!invitation || invitationState(invitation) !== 'pending')
		return messagePage('Invitation unavailable', 'This invitation is no longer valid.', 410)
	if (form.get('intent') === 'continue') {
		const session = await getBrowserSession(c.req, c.env, c.config)
		if (!session || session.user.email !== invitation.email)
			return renderInvitation(c, invitation, { error: 'Sign in as the invited user.', status: 401 })
		await acceptInvitationRow(c.env, c.ctx, invitation, session.user)
		return invitationDone(c, session.user, [])
	}
	if (normalizeEmail(field(form, 'email')) !== invitation.email) {
		return renderInvitation(c, invitation, {
			error: 'This invitation was sent to a different email address.',
			status: 400,
		})
	}
	const result = await authenticateForm(c, form, invitation)
	if (!result.ok) return renderInvitation(c, invitation, { error: result.message, status: result.status })
	return invitationDone(c, result.user, [result.setCookie])
}

/** GET/POST /invitations: org admins see pending invitations and their acceptance links. */
export async function invitationsAdmin(c: Ctx): Promise<Response> {
	const { env, config, req } = c
	const session = await getBrowserSession(req, env, config)
	if (req.method === 'POST') {
		const form = await readForm(req)
		if (!form || !(await verifyCsrf(req, config, form))) return csrfFailure()
		const result = await authenticateForm(c, form, null)
		if (!result.ok) {
			const csrf = csrfToken(req, config)
			return withHeaders(
				page(
					'Invitations',
					credentialsForm({
						action: '/invitations',
						mode: 'sign_in',
						csrf: csrf.token,
						hiddenFields: {},
						error: result.message,
						heading: 'Sign in to view invitations',
					}),
					result.status,
				),
				[setCookieHeader(csrf.setCookie)],
			)
		}
		return redirect('/invitations', 303, [result.setCookie])
	}
	if (!session) {
		const csrf = csrfToken(req, config)
		return withHeaders(
			page(
				'Invitations',
				credentialsForm({
					action: '/invitations',
					mode: 'sign_in',
					csrf: csrf.token,
					hiddenFields: {},
					heading: 'Sign in to view invitations',
				}),
			),
			[setCookieHeader(csrf.setCookie)],
		)
	}
	const memberships = (await activeMemberships(env.DB, session.user.id)).filter((m) => m.role_slug === 'admin')
	let inner = `<h1>Pending invitations</h1><p class="muted">Signed in as ${esc(session.user.email)}. Invitations are not emailed; share each link with the invitee.</p>`
	if (memberships.length === 0) inner += '<p>You are not an admin of any organization.</p>'
	for (const m of memberships) {
		const { results } = await env.DB.prepare(
			"SELECT * FROM invitations WHERE organization_id = ? AND state = 'pending' ORDER BY created_at DESC",
		)
			.bind(m.organization_id)
			.all<InvitationRow>()
		const rows = results.filter((r) => invitationState(r) === 'pending')
		inner += `<h2 style="font-size:1rem;margin-top:20px">${esc(m.organization_name)}</h2>`
		inner += rows.length
			? `<table><tr><th>Email</th><th>Link</th></tr>${rows
					.map(
						(r) =>
							`<tr><td>${esc(r.email)}<br><span class="muted">expires ${esc(r.expires_at.slice(0, 10))}</span></td><td><code>${esc(acceptInvitationUrl(config.publicUrl, r.token))}</code></td></tr>`,
					)
					.join('')}</table>`
			: '<p class="muted">No pending invitations.</p>'
	}
	return page('Invitations', inner)
}
