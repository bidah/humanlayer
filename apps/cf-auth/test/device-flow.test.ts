// Device authorization as the CLI performs it (apps/cli/src/auth/workos-device-auth.ts, imported as-is)
// and as the session SDK performs it (packages/session-sdk-auth/src/login.ts: form posts, user.email).
import { beforeAll, describe, expect, it } from 'vitest'

import { pollForToken, requestDeviceCodes } from '../../cli/src/auth/workos-device-auth'
import {
	Browser,
	baseUrl,
	clientId,
	parseForms,
	signUpUser,
	uniqueEmail,
	validateLikeRiptideApi,
	workosV10,
} from './helpers'

const PASSWORD = 'correct horse battery staple'

async function approveInBrowser(
	verificationUriComplete: string,
	email: string,
	orgId?: string,
	intent: 'continue' | 'deny' = 'continue',
) {
	const browser = new Browser()
	let res = await browser.get(verificationUriComplete)
	let html = await res.text()
	expect(res.status).toBe(200)
	res = await browser.submit(html, 'sign_in', { email, password: PASSWORD })
	expect(res.status).toBe(303)
	res = await browser.get(res.headers.get('location')!)
	html = await res.text()
	expect(html).toContain('Approve this device?')
	const form = parseForms(html).find((f) => f.fields.intent === intent)!
	res = await browser.post(form.action, { ...form.fields, ...(orgId ? { organization_choice: orgId } : {}) })
	return { status: res.status, html: await res.text() }
}

describe('device authorization flow', () => {
	let email: string
	let userId: string
	let orgA: string
	let orgB: string

	beforeAll(async () => {
		email = uniqueEmail('cli')
		const { tokens } = await signUpUser(email, PASSWORD)
		userId = tokens.user.id
		const workos = workosV10()
		for (const name of ['CLI A', 'CLI B']) {
			const org = await workos.organizations.createOrganization({ name })
			await workos.organizations.updateOrganization({
				organization: org.id,
				metadata: { internal_org_id: `internal-${org.id}` },
			})
			await workos.userManagement.createOrganizationMembership({
				userId,
				organizationId: org.id,
				roleSlug: 'member',
			})
			if (name === 'CLI A') orgA = org.id
			else orgB = org.id
		}
	})

	it('CLI: requestDeviceCodes -> browser approval with org pick -> pollForToken -> org refresh', async () => {
		process.env.HUMANLAYER_WORKOS_URL = baseUrl()
		const codes = await requestDeviceCodes(clientId())
		expect(codes.verification_uri).toBe(`${baseUrl()}/device`)
		expect(codes.verification_uri_complete).toBe(`${baseUrl()}/device?user_code=${codes.user_code}`)
		expect(codes.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
		expect(codes.interval).toBe(5)

		const polling = pollForToken(clientId(), codes.device_code, codes.interval)
		const approval = await approveInBrowser(codes.verification_uri_complete, email, orgB)
		expect(approval.html).toContain('Device connected')
		const result = await polling
		expect(result.user).toMatchObject({ id: userId, email })
		expect(result.organization_id).toBe(orgB)

		// Step 5 of `humanlayer login`: the API's token refresh (authenticateWithRefreshToken with the API key).
		const refreshed = await workosV10().userManagement.authenticateWithRefreshToken({
			clientId: clientId(),
			refreshToken: result.refresh_token,
			organizationId: orgA,
		})
		const claims = await validateLikeRiptideApi(refreshed.accessToken, `${baseUrl()}/sso/jwks/${clientId()}`)
		expect(claims).toMatchObject({ sub: userId, org_id: orgA, internal_org_id: `internal-${orgA}` })

		// A device code is single use.
		const again = await fetch(`${baseUrl()}/user_management/authenticate`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: codes.device_code,
				client_id: clientId(),
			}),
		})
		expect(((await again.json()) as { error: string }).error).toBe('invalid_grant')
	}, 30_000)

	it('session SDK wire format: pending, slow_down, then denied -> access_denied', async () => {
		const form = (path: string, body: Record<string, string>) =>
			fetch(`${baseUrl()}/user_management/${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ ...body, client_id: clientId() }),
			})
		const dc = (await (await form('authorize/device', {})).json()) as Record<string, string>
		const poll = async () =>
			(await (
				await form('authenticate', {
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					device_code: dc.device_code!,
				})
			).json()) as {
				error?: string
			}
		expect((await poll()).error).toBe('authorization_pending')
		expect((await poll()).error).toBe('slow_down')
		const denied = await approveInBrowser(dc.verification_uri_complete!, email, undefined, 'deny')
		expect(denied.html).toContain('Request denied')
		expect((await poll()).error).toBe('access_denied')
	})

	it('rejects an unknown user code on the device page', async () => {
		const res = await new Browser().get('/device?user_code=BBBB-CCCC')
		expect(res.status).toBe(400)
		expect(await res.text()).toContain('invalid or has expired')
	})
})
