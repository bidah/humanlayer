// The real @workos-inc/authkit-js 0.20.2 client (what authkit-react 0.16.2 wraps), configured the way
// riptide-cloud's AuthProvider is (devMode, redirect to /auth/callback) plus the apiHostname seam.
// There is no browser, so the window/storage globals it touches are shimmed and the hosted page is
// driven over HTTP.
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest'

import {
	Browser,
	baseUrl,
	clientId,
	completeAuthorize,
	decodeJwtPayload,
	postToken,
	signUpUser,
	uniqueEmail,
	validateLikeRiptideApi,
	workosV10,
} from './helpers'

class MemStorage {
	private m = new Map<string, string>()
	getItem(k: string) {
		return this.m.has(k) ? this.m.get(k)! : null
	}
	setItem(k: string, v: string) {
		this.m.set(k, String(v))
	}
	removeItem(k: string) {
		this.m.delete(k)
	}
	clear() {
		this.m.clear()
	}
}

const APP_ORIGIN = 'http://localhost:5174'
let currentHref = `${APP_ORIGIN}/`
const g = globalThis as Record<string, unknown>
const saved: Record<string, PropertyDescriptor | undefined> = {}

function shim(name: string, value: unknown) {
	saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function installBrowserGlobals() {
	const location = {
		get href() {
			return currentHref
		},
		get origin() {
			return new URL(currentHref).origin
		},
		get hostname() {
			return new URL(currentHref).hostname
		},
		get pathname() {
			return new URL(currentHref).pathname
		},
		get search() {
			return new URL(currentHref).search
		},
		toString() {
			return currentHref
		},
		assign(url: string) {
			currentHref = url
		},
	}
	shim('location', location)
	shim('sessionStorage', new MemStorage())
	shim('localStorage', new MemStorage())
	shim('document', { cookie: '', hidden: false })
	shim('history', { replaceState: (_s: unknown, _t: string, url: URL | string) => (currentHref = String(url)) })
	shim('window', globalThis)
	g.origin = APP_ORIGIN
}

const PASSWORD = 'correct horse battery staple'

describe('authkit-js client flow: authorize -> sign-in -> PKCE code exchange -> refresh -> org switch -> sign-out', () => {
	let createClient: typeof import('@workos-inc/authkit-js').createClient
	let email: string
	let userId: string
	const orgs: Array<{ id: string; internal: string }> = []

	beforeAll(async () => {
		installBrowserGlobals()
		;({ createClient } = await import('@workos-inc/authkit-js'))
		email = uniqueEmail('browser')
		const { tokens } = await signUpUser(email, PASSWORD)
		userId = tokens.user.id
		const workos = workosV10()
		for (const name of ['Org A', 'Org B']) {
			const org = await workos.organizations.createOrganization({ name })
			const internal = `internal-${name.replace(' ', '-').toLowerCase()}-${Date.now()}`
			await workos.organizations.updateOrganization({
				organization: org.id,
				metadata: { internal_org_id: internal },
			})
			await workos.userManagement.createOrganizationMembership({
				userId,
				organizationId: org.id,
				roleSlug: 'admin',
			})
			orgs.push({ id: org.id, internal })
		}
	})

	afterAll(() => {
		for (const [name, desc] of Object.entries(saved)) {
			if (desc) Object.defineProperty(globalThis, name, desc)
			else delete g[name]
		}
	})

	const options = (onRedirectCallback = vi.fn()) => ({
		apiHostname: '127.0.0.1',
		port: inject('port'),
		https: false,
		redirectUri: `${APP_ORIGIN}/auth/callback`,
		devMode: true,
		onRedirectCallback,
	})

	it('runs the whole lifecycle with the unmodified SDK', async () => {
		// 1. App boots with no session and builds the sign-in URL (PKCE S256, verifier in sessionStorage).
		const boot = await createClient(clientId(), options())
		const signInUrl = await boot.getSignInUrl()
		const parsed = new URL(signInUrl)
		expect(parsed.origin).toBe(baseUrl())
		expect(parsed.pathname).toBe('/user_management/authorize')
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
		expect(sessionStorage.getItem('workos:code-verifier')).toBeTruthy()
		boot.dispose()

		// 2. User signs in on the hosted page, picks Org A (two memberships -> picker).
		const browser = new Browser()
		const location = await completeAuthorize(browser, signInUrl, {
			email,
			password: PASSWORD,
			organizationChoice: orgs[0]!.id,
		})
		const callback = new URL(location)
		expect(callback.origin + callback.pathname).toBe(`${APP_ORIGIN}/auth/callback`)
		expect(callback.searchParams.get('code')).toBeTruthy()

		// 3. Browser lands on the callback; the SDK exchanges code + verifier.
		currentHref = location
		const onRedirect = vi.fn()
		const client = await createClient(clientId(), options(onRedirect))
		expect(onRedirect).toHaveBeenCalledTimes(1)
		const redirectParams = onRedirect.mock.calls[0]![0]
		expect(redirectParams.user).toMatchObject({ id: userId, email })
		expect(redirectParams.organizationId).toBe(orgs[0]!.id)
		expect(new URL(currentHref).searchParams.has('code')).toBe(false) // SDK cleaned the URL
		expect(client.getUser()?.email).toBe(email)

		const jwksUrl = `${baseUrl()}/sso/jwks/${clientId()}`
		const token1 = await client.getAccessToken()
		const claims1 = await validateLikeRiptideApi(token1, jwksUrl)
		expect(claims1).toMatchObject({
			sub: userId,
			org_id: orgs[0]!.id,
			internal_org_id: orgs[0]!.internal,
			role: 'admin',
		})

		// 4. Refresh (devMode keeps the refresh token in localStorage and sends it in the body); it rotates.
		const rtKey = `workos:refresh-token:${clientId()}`
		const rt1 = localStorage.getItem(rtKey)
		const token2 = await client.getAccessToken({ forceRefresh: true })
		const rt2 = localStorage.getItem(rtKey)
		expect(rt2).toBeTruthy()
		expect(rt2).not.toBe(rt1)
		expect(decodeJwtPayload(token2).jti).not.toBe(decodeJwtPayload(token1).jti)
		expect(decodeJwtPayload(token2).sid).toBe(claims1.sid)

		// 5. Organization switch = refresh with organization_id.
		await client.switchToOrganization({ organizationId: orgs[1]!.id })
		const claims3 = await validateLikeRiptideApi(await client.getAccessToken(), jwksUrl)
		expect(claims3).toMatchObject({ org_id: orgs[1]!.id, internal_org_id: orgs[1]!.internal, sid: claims1.sid })

		// 6. Sign-out (navigate: false fetches the logout URL) ends the session server-side.
		const rtBeforeSignOut = localStorage.getItem(rtKey)!
		await client.signOut({ navigate: false })
		expect(client.getUser()).toBeNull()
		const afterLogout = await postToken({
			grant_type: 'refresh_token',
			client_id: clientId(),
			refresh_token: rtBeforeSignOut,
		})
		expect(afterLogout.status).toBe(400)
		expect(afterLogout.body.error).toBe('invalid_grant')
		client.dispose()
	})

	it('signOut with navigation redirects only to allowlisted return_to', async () => {
		const res = await fetch(
			`${baseUrl()}/user_management/sessions/logout?session_id=session_x&return_to=${encodeURIComponent(`${APP_ORIGIN}/`)}`,
			{ redirect: 'manual' },
		)
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`${APP_ORIGIN}/`)
		const evil = await fetch(
			`${baseUrl()}/user_management/sessions/logout?session_id=session_x&return_to=${encodeURIComponent('https://evil.example/')}`,
			{ redirect: 'manual' },
		)
		expect(evil.status).toBe(200)
		expect(evil.headers.get('location')).toBeNull()
	})

	it('CORS: token endpoint allows the app origins and nothing else', async () => {
		const preflight = (origin: string) =>
			fetch(`${baseUrl()}/user_management/authenticate`, {
				method: 'OPTIONS',
				headers: {
					origin,
					'access-control-request-method': 'POST',
					'access-control-request-headers': 'content-type',
				},
			})
		const ok = await preflight(APP_ORIGIN)
		expect(ok.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
		const bad = await preflight('https://evil.example')
		expect(bad.headers.get('access-control-allow-origin')).toBeNull()
	})
})
