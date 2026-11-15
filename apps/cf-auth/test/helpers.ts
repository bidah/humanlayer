import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { parseWorkOsAccessTokenClaims } from '@humanlayer/schemas/effect/workos-access-token'
import { WorkOS } from '@workos-inc/node'
import { importJWK, jwtVerify, type JWK } from 'jose'
import { inject } from 'vitest'

export const baseUrl = () => inject('baseUrl')
export const clientId = () => inject('clientId')
export const apiKey = () => inject('apiKey')

/** The v10 SDK exactly as riptide-api constructs it, plus the host override seam. */
export function workosV10(): WorkOS {
	return new WorkOS(apiKey(), { apiHostname: '127.0.0.1', port: inject('port'), https: false, clientId: clientId() })
}

const decodeHtml = (s: string) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')

export interface ParsedForm {
	action: string
	method: string
	fields: Record<string, string>
	selects: Record<string, string[]>
}

export function parseForms(html: string): ParsedForm[] {
	const forms: ParsedForm[] = []
	for (const m of html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)) {
		const attrs = m[1]!
		const inner = m[2]!
		const action = decodeHtml(/action="([^"]*)"/.exec(attrs)?.[1] ?? '')
		const method = (/method="([^"]*)"/.exec(attrs)?.[1] ?? 'get').toLowerCase()
		const fields: Record<string, string> = {}
		for (const input of inner.matchAll(/<input([^>]*)>/g)) {
			const name = /name="([^"]*)"/.exec(input[1]!)?.[1]
			const value = /value="([^"]*)"/.exec(input[1]!)?.[1]
			if (name) fields[name] = decodeHtml(value ?? '')
		}
		const selects: Record<string, string[]> = {}
		for (const sel of inner.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
			selects[sel[1]!] = [...sel[2]!.matchAll(/<option value="([^"]*)"/g)].map((o) => decodeHtml(o[1]!))
		}
		forms.push({ action, method, fields, selects })
	}
	return forms
}

/** Minimal browser: cookie jar, manual redirects, form posts. */
export class Browser {
	readonly cookies = new Map<string, string>()

	private absorb(res: Response) {
		for (const line of res.headers.getSetCookie()) {
			const [pair, ...attrs] = line.split(';')
			const idx = pair!.indexOf('=')
			const name = pair!.slice(0, idx).trim()
			const value = decodeURIComponent(pair!.slice(idx + 1).trim())
			const maxAge = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('max-age='))
			if (value === '' || maxAge === 'Max-Age=0') this.cookies.delete(name)
			else this.cookies.set(name, value)
		}
	}

	private headers(extra: Record<string, string> = {}) {
		const cookie = [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
		return { ...(cookie ? { cookie } : {}), ...extra }
	}

	async get(url: string): Promise<Response> {
		const res = await fetch(new URL(url, baseUrl()), { redirect: 'manual', headers: this.headers() })
		this.absorb(res)
		return res
	}

	async post(
		url: string,
		fields: Record<string, string>,
		extraHeaders: Record<string, string> = {},
	): Promise<Response> {
		const res = await fetch(new URL(url, baseUrl()), {
			method: 'POST',
			redirect: 'manual',
			headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }),
			body: new URLSearchParams(fields),
		})
		this.absorb(res)
		return res
	}

	/** Submit the page's form whose hidden `intent` matches, overriding fields. */
	async submit(html: string, intent: string, values: Record<string, string> = {}): Promise<Response> {
		const form = parseForms(html).find((f) => f.method === 'post' && f.fields.intent === intent)
		if (!form) throw new Error(`no form with intent ${intent} in page:\n${html.slice(0, 2000)}`)
		return this.post(form.action, { ...form.fields, ...values })
	}
}

/**
 * Drive the hosted authorize page like a user would: credentials form (sign_in or sign_up), then the
 * organization picker if one is shown. Returns the final redirect Location.
 */
export async function completeAuthorize(
	browser: Browser,
	authorizeUrl: string,
	opts: { email: string; password: string; mode?: 'sign_in' | 'sign_up'; organizationChoice?: string },
): Promise<string> {
	let res = await browser.get(authorizeUrl)
	let html = await res.text()
	if (res.status !== 200) throw new Error(`authorize page returned ${res.status}: ${html.slice(0, 500)}`)
	const forms = parseForms(html)
	const credentials = forms.find((f) => f.fields.intent === 'sign_in' || f.fields.intent === 'sign_up')
	if (credentials) {
		res = await browser.post(credentials.action, {
			...credentials.fields,
			intent: opts.mode ?? 'sign_in',
			email: opts.email,
			password: opts.password,
		})
	} else {
		res = await browser.submit(
			html,
			'continue',
			opts.organizationChoice ? { organization_choice: opts.organizationChoice } : {},
		)
	}
	if (res.status === 200) {
		html = await res.text()
		const picker = parseForms(html).find((f) => f.fields.intent === 'continue')
		if (!picker) throw new Error(`unexpected page after sign-in:\n${html.slice(0, 1500)}`)
		const choice = opts.organizationChoice ?? picker.selects.organization_choice?.[0]
		res = await browser.post(picker.action, {
			...picker.fields,
			...(choice ? { organization_choice: choice } : {}),
		})
	}
	if (res.status !== 303)
		throw new Error(`expected 303 from authorize, got ${res.status}: ${(await res.text()).slice(0, 1500)}`)
	return res.headers.get('location')!
}

export async function pkcePair() {
	const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url')
	const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString(
		'base64url',
	)
	return { verifier, challenge }
}

export function authorizeUrlFor(params: Record<string, string | undefined>): string {
	const q = new URLSearchParams()
	q.set('client_id', clientId())
	q.set('response_type', 'code')
	q.set('provider', 'authkit')
	for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
	return `${baseUrl()}/user_management/authorize?${q}`
}

export async function postToken(body: Record<string, string | undefined>, headers: Record<string, string> = {}) {
	const res = await fetch(`${baseUrl()}/user_management/authenticate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
	return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers }
}

/** Sign a new user up (email domain allowlisted for the test run) and return their tokens. */
export async function signUpUser(email: string, password: string, extra: Record<string, string> = {}) {
	const browser = new Browser()
	const { verifier, challenge } = await pkcePair()
	const location = await completeAuthorize(
		browser,
		authorizeUrlFor({
			redirect_uri: 'http://localhost:5174/auth/callback',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			...extra,
		}),
		{ email, password, mode: 'sign_up' },
	)
	const code = new URL(location).searchParams.get('code')!
	const tokens = await postToken({
		grant_type: 'authorization_code',
		client_id: clientId(),
		code,
		code_verifier: verifier,
	})
	if (tokens.status !== 200) throw new Error(`code exchange failed: ${JSON.stringify(tokens.body)}`)
	return { browser, tokens: tokens.body }
}

/** Verify an access token exactly as apps/riptide-api/src/auth/jwt-validator.ts does, then decode the claims. */
export async function validateLikeRiptideApi(token: string, jwksUrl: string) {
	const res = await fetch(jwksUrl)
	const data = (await res.json()) as { keys: JWK[] }
	const keys = new Map<string, Awaited<ReturnType<typeof importJWK>>>()
	for (const jwk of data.keys) if (jwk.kid) keys.set(jwk.kid, await importJWK(jwk))
	const [headerB64, payloadB64] = token.split('.')
	const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString())
	const key = keys.get(header.kid)
	if (!key) throw new Error('kid not in JWKS')
	const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString())
	const { payload: verified } = await jwtVerify(token, key, { issuer: payload.iss })
	return parseWorkOsAccessTokenClaims(verified)
}

export function decodeJwtPayload(token: string): Record<string, any> {
	return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
}

/** Run SQL against the local D1 the dev server uses (for time-travel style negative tests only). */
export function d1Local(sql: string): void {
	execFileSync(
		resolve(import.meta.dirname, '../node_modules/.bin/wrangler'),
		['d1', 'execute', 'humanlayer-auth', '--local', '--persist-to', inject('persistDir'), '--command', sql],
		{ cwd: resolve(import.meta.dirname, '..'), stdio: 'pipe', env: { ...process.env, CI: '1' } },
	)
}

export async function sha256b64(input: string) {
	return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))).toString('base64url')
}

export const uniqueEmail = (prefix: string, domain = 'allowed.test') =>
	`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@${domain}`
