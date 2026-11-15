import { beforeAll, describe, expect, it } from 'vitest'

import {
	Browser,
	authorizeUrlFor,
	baseUrl,
	clientId,
	completeAuthorize,
	d1Local,
	parseForms,
	pkcePair,
	postToken,
	sha256b64,
	signUpUser,
	uniqueEmail,
} from './helpers'

const PASSWORD = 'correct horse battery staple'
const REDIRECT = 'http://localhost:5174/auth/callback'

async function freshCode(email: string) {
	const { verifier, challenge } = await pkcePair()
	const location = await completeAuthorize(
		new Browser(),
		authorizeUrlFor({ redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
		{ email, password: PASSWORD },
	)
	return { code: new URL(location).searchParams.get('code')!, verifier }
}

async function signInAttempt(email: string, password: string) {
	const browser = new Browser()
	const { challenge } = await pkcePair()
	const page = await browser.get(
		authorizeUrlFor({ redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
	)
	const res = await browser.submit(await page.text(), 'sign_in', { email, password })
	return { status: res.status, html: await res.text(), location: res.headers.get('location') }
}

describe('negative paths', () => {
	let email: string

	beforeAll(async () => {
		email = uniqueEmail('neg')
		await signUpUser(email, PASSWORD)
	})

	it('wrong password and unknown email get the same generic 401', async () => {
		const wrong = await signInAttempt(email, 'not the password at all')
		expect(wrong.status).toBe(401)
		expect(wrong.html).toContain('Invalid email or password.')
		expect(wrong.location).toBeNull()
		const unknown = await signInAttempt(uniqueEmail('nobody'), 'not the password at all')
		expect(unknown.status).toBe(401)
		expect(unknown.html).toContain('Invalid email or password.')
	})

	it('locks an email after 10 failures, even for the right password', async () => {
		const target = uniqueEmail('locked')
		await signUpUser(target, PASSWORD)
		for (let i = 0; i < 10; i++) expect((await signInAttempt(target, `wrong-${i}-xxxxxxxx`)).status).toBe(401)
		const locked = await signInAttempt(target, PASSWORD)
		expect(locked.status).toBe(429)
		expect(locked.html).toContain('Too many sign-in attempts')
	})

	it('authorization codes are single use; replay revokes what the first exchange issued', async () => {
		const { code, verifier } = await freshCode(email)
		const first = await postToken({
			grant_type: 'authorization_code',
			client_id: clientId(),
			code,
			code_verifier: verifier,
		})
		expect(first.status).toBe(200)
		const replay = await postToken({
			grant_type: 'authorization_code',
			client_id: clientId(),
			code,
			code_verifier: verifier,
		})
		expect(replay.status).toBe(400)
		expect(replay.body).toEqual({ error: 'invalid_grant', error_description: 'The code has already been used.' })
		const refresh = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: first.body.refresh_token,
		})
		expect(refresh.body.error).toBe('invalid_grant')
	})

	it('expired authorization code is rejected', async () => {
		const { code, verifier } = await freshCode(email)
		d1Local(`UPDATE authorization_codes SET expires_at = 1 WHERE code_hash = '${await sha256b64(code)}'`)
		const res = await postToken({
			grant_type: 'authorization_code',
			client_id: clientId(),
			code,
			code_verifier: verifier,
		})
		expect(res.status).toBe(400)
		expect(res.body).toMatchObject({ error: 'invalid_grant', error_description: 'The code has expired.' })
	})

	it('PKCE verifier mismatch is rejected (and the code is burned)', async () => {
		const { code, verifier } = await freshCode(email)
		const bad = await postToken({
			grant_type: 'authorization_code',
			client_id: clientId(),
			code,
			code_verifier: `${verifier}x`,
		})
		expect(bad.body).toMatchObject({ error: 'invalid_grant', error_description: 'PKCE verification failed.' })
		const missing = await freshCode(email)
		const none = await postToken({ grant_type: 'authorization_code', client_id: clientId(), code: missing.code })
		expect(none.body.error).toBe('invalid_grant')
		const good = await postToken({
			grant_type: 'authorization_code',
			client_id: clientId(),
			code,
			code_verifier: verifier,
		})
		expect(good.status).toBe(400)
	})

	it('redirect_uri must be on the allowlist; no redirect is ever issued for a bad one', async () => {
		const { challenge } = await pkcePair()
		for (const redirect of [
			'https://evil.example/callback',
			'http://localhost:5174.evil.example/auth/callback',
			'http://user@localhost:5174/auth/callback',
			'javascript:alert(1)',
			'riptide://oauth/other',
		]) {
			const res = await fetch(
				authorizeUrlFor({ redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' }),
				{ redirect: 'manual' },
			)
			expect(res.status, redirect).toBe(400)
			expect(res.headers.get('location')).toBeNull()
		}
		// Tampering with the hidden field on the form post is also refused.
		const browser = new Browser()
		const page = await browser.get(
			authorizeUrlFor({ redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
		)
		const res = await browser.submit(await page.text(), 'sign_in', {
			email,
			password: PASSWORD,
			redirect_uri: 'https://evil.example/',
		})
		expect(res.status).toBe(400)
		expect(res.headers.get('location')).toBeNull()
	})

	it('authorize without PKCE, with a wrong client_id or another provider is refused', async () => {
		expect((await fetch(authorizeUrlFor({ redirect_uri: REDIRECT }))).status).toBe(400)
		const { challenge } = await pkcePair()
		const wrongClient = authorizeUrlFor({
			redirect_uri: REDIRECT,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		}).replace(`client_id=${clientId()}`, 'client_id=client_other')
		expect((await fetch(wrongClient)).status).toBe(400)
		const plain = await fetch(
			authorizeUrlFor({ redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'plain' }),
		)
		expect(plain.status).toBe(400)
	})

	it('sign-up is closed to emails that are neither invited nor allowlisted', async () => {
		const browser = new Browser()
		const { challenge } = await pkcePair()
		const page = await browser.get(
			authorizeUrlFor({
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				screen_hint: 'sign-up',
			}),
		)
		const html = await page.text()
		expect(parseForms(html).some((f) => f.fields.intent === 'sign_up')).toBe(true)
		const res = await browser.submit(html, 'sign_up', {
			email: uniqueEmail('stranger', 'not-allowed.test'),
			password: PASSWORD,
		})
		expect(res.status).toBe(403)
		expect(await res.text()).toContain('Sign-up is by invitation only')
	})

	it('rotated refresh tokens cannot be reused; reuse revokes the whole session', async () => {
		const { code, verifier } = await freshCode(email)
		const t0 = (
			await postToken({ grant_type: 'authorization_code', client_id: clientId(), code, code_verifier: verifier })
		).body
		const t1 = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: t0.refresh_token,
		})
		expect(t1.status).toBe(200)
		const reuse = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: t0.refresh_token,
		})
		expect(reuse.body).toEqual({ error: 'invalid_grant', error_description: 'Refresh token already exchanged.' })
		const latest = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: t1.body.refresh_token,
		})
		expect(latest.body.error).toBe('invalid_grant')
	})

	it('refresh into an organization the user is not a member of is refused without burning the token', async () => {
		const { code, verifier } = await freshCode(email)
		const t0 = (
			await postToken({ grant_type: 'authorization_code', client_id: clientId(), code, code_verifier: verifier })
		).body
		const denied = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: t0.refresh_token,
			organization_id: 'org_01NOTAMEMBER0000000000000',
		})
		expect(denied.body.error).toBe('invalid_grant')
		const still = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: t0.refresh_token,
		})
		expect(still.status).toBe(200)
	})

	it('form posts without a matching CSRF token, or from another origin, are refused', async () => {
		const browser = new Browser()
		const { challenge } = await pkcePair()
		const page = await browser.get(
			authorizeUrlFor({ redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }),
		)
		const form = parseForms(await page.text()).find((f) => f.fields.intent === 'sign_in')!
		const noToken = await browser.post(form.action, {
			...form.fields,
			csrf_token: 'forged',
			email,
			password: PASSWORD,
		})
		expect(noToken.status).toBe(403)
		const crossSite = await browser.post(
			form.action,
			{ ...form.fields, email, password: PASSWORD },
			{ origin: 'https://evil.example' },
		)
		expect(crossSite.status).toBe(403)
		const fresh = new Browser() // no CSRF cookie at all
		expect((await fresh.post(form.action, { ...form.fields, email, password: PASSWORD })).status).toBe(403)
	})

	it('token endpoint: wrong client_secret is 401 invalid_client; unknown grant is unsupported', async () => {
		const bad = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			client_secret: 'sk_wrong',
			refresh_token: 'x',
		})
		expect(bad.status).toBe(401)
		expect(bad.body.error).toBe('invalid_client')
		const pw = await postToken({ grant_type: 'password', client_id: clientId(), email, password: PASSWORD })
		expect(pw.body.error).toBe('unsupported_grant_type')
	})

	it('management API requires the API key', async () => {
		const res = await fetch(`${baseUrl()}/user_management/users`)
		expect(res.status).toBe(401)
	})
})
