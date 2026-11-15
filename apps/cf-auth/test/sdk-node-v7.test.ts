// @workos-inc/node 7.82.0 (riptide-electric-proxy's version). The proxy only calls getJwksUrl and then
// verifies tokens itself; the rest exercises the shared endpoints through the older deserializers too.
import { parseWorkOsAccessTokenClaims } from '@humanlayer/schemas/effect/workos-access-token'
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { WorkOS as WorkOSv7 } from 'workos-node-v7'

import { apiKey, baseUrl, clientId, signUpUser, uniqueEmail, workosV10 } from './helpers'

describe('@workos-inc/node 7.82.0 (riptide-electric-proxy)', () => {
	let workos: WorkOSv7
	let userId: string
	let refreshToken: string
	let orgId: string

	beforeAll(async () => {
		workos = new WorkOSv7(apiKey(), { apiHostname: '127.0.0.1', port: inject('port'), https: false })
		const { tokens } = await signUpUser(uniqueEmail('proxy'), 'correct horse battery staple')
		userId = tokens.user.id
		refreshToken = tokens.refresh_token
		const v10 = workosV10()
		const org = await v10.organizations.createOrganization({ name: 'Proxy Org' })
		await v10.organizations.updateOrganization({
			organization: org.id,
			metadata: { internal_org_id: 'internal-proxy-org' },
		})
		await v10.userManagement.createOrganizationMembership({ userId, organizationId: org.id, roleSlug: 'member' })
		orgId = org.id
	})

	it('getJwksUrl matches the URL the proxy will fetch', () => {
		expect(workos.userManagement.getJwksUrl(clientId())).toBe(`${baseUrl()}/sso/jwks/${clientId()}`)
	})

	it('a token passes the proxy validator logic (kid, issuer, claim schema, internal_org_id required)', async () => {
		const refreshed = await workos.userManagement.authenticateWithRefreshToken({
			clientId: clientId(),
			refreshToken,
			organizationId: orgId,
		})
		expect(refreshed.organizationId).toBe(orgId)
		const token = refreshed.accessToken

		// Mirrors apps/riptide-electric-proxy/src/auth/effect/jwt-validator.service.ts + jwks-cache.service.ts.
		const jwks = (await (await fetch(workos.userManagement.getJwksUrl(clientId()))).json()) as { keys: JWK[] }
		const { kid } = decodeProtectedHeader(token)
		const { iss } = decodeJwt(token)
		const jwk = jwks.keys.find((k) => k.kid === kid)!
		const { payload } = await jwtVerify(token, await importJWK(jwk), { issuer: iss! })
		const claims = parseWorkOsAccessTokenClaims(payload)
		expect(claims.internal_org_id).toBe('internal-proxy-org')
		expect(claims.org_id).toBe(orgId)
		expect(claims.sid).toBeTruthy()
	})

	it('shared server calls deserialize under v7', async () => {
		expect((await workos.userManagement.getUser(userId)).id).toBe(userId)
		const memberships = await workos.userManagement.listOrganizationMemberships({ userId })
		expect(memberships.data.map((m) => m.organizationId)).toContain(orgId)
		const org = await workos.organizations.getOrganization(orgId)
		expect(org.name).toBe('Proxy Org')
		const invitations = await workos.userManagement.listInvitations({ organizationId: orgId })
		expect(invitations.data).toEqual([])
	})
})
