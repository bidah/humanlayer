// Every @workos-inc/node (10.11.0, riptide-api's version) call riptide-api makes, against the Worker.
import { DomainDataState, type WorkOS } from '@workos-inc/node'
import { beforeAll, describe, expect, inject, it } from 'vitest'

import {
	baseUrl,
	clientId,
	decodeJwtPayload,
	signUpUser,
	uniqueEmail,
	validateLikeRiptideApi,
	workosV10,
} from './helpers'

const PASSWORD = 'correct horse battery staple'

describe('@workos-inc/node 10.11.0 server calls (riptide-api)', () => {
	let workos: WorkOS
	let admin: { id: string; email: string; refreshToken: string }
	let member: { id: string; email: string }
	let orgId: string
	const internalOrgId = '019b049c-950d-7baa-b9a8-b9364599319b'

	beforeAll(async () => {
		workos = workosV10()
		const a = await signUpUser(uniqueEmail('admin'), PASSWORD)
		admin = { id: a.tokens.user.id, email: a.tokens.user.email, refreshToken: a.tokens.refresh_token }
		const m = await signUpUser(uniqueEmail('member'), PASSWORD)
		member = { id: m.tokens.user.id, email: m.tokens.user.email }
	})

	it('getJwksUrl points at this service and serves RS256 keys', async () => {
		const url = workos.userManagement.getJwksUrl(clientId())
		expect(url).toBe(`${baseUrl()}/sso/jwks/${clientId()}`)
		const jwks = (await (await fetch(url)).json()) as { keys: Array<Record<string, string>> }
		expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
		expect(jwks.keys[0]!.kid).toBeTruthy()
	})

	it('organizations.createOrganization / updateOrganization (metadata.internal_org_id) / getOrganization', async () => {
		const created = await workos.organizations.createOrganization({
			name: 'Acme',
			domainData: [{ domain: `acme-${Date.now()}.example`, state: DomainDataState.Pending }],
		})
		expect(created.id).toMatch(/^org_[0-9A-Z]{26}$/)
		expect(created.domains[0]).toMatchObject({ state: 'pending', organizationId: created.id })
		orgId = created.id

		const updated = await workos.organizations.updateOrganization({
			organization: orgId,
			stripeCustomerId: 'cus_test123',
			metadata: { internal_org_id: internalOrgId },
		})
		expect(updated.metadata).toEqual({ internal_org_id: internalOrgId })
		expect(updated.stripeCustomerId).toBe('cus_test123')

		const fetched = await workos.organizations.getOrganization(orgId)
		expect(fetched).toMatchObject({ id: orgId, name: 'Acme', metadata: { internal_org_id: internalOrgId } })
	})

	it('userManagement.createOrganizationMembership (admin) and listOrganizationMemberships', async () => {
		const membership = await workos.userManagement.createOrganizationMembership({
			userId: admin.id,
			organizationId: orgId,
			roleSlug: 'admin',
		})
		expect(membership).toMatchObject({
			userId: admin.id,
			organizationId: orgId,
			status: 'active',
			role: { slug: 'admin' },
		})

		const list = await workos.userManagement.listOrganizationMemberships({ userId: admin.id, limit: 100 })
		const all = await list.autoPagination()
		expect(all.map((m) => m.organizationId)).toContain(orgId)

		const active = await (
			await workos.userManagement.listOrganizationMemberships({ organizationId: orgId, statuses: ['active'] })
		).autoPagination()
		expect(active).toHaveLength(1)
	})

	it('getAuthorizationUrl builds a URL on this host', () => {
		const url = workos.userManagement.getAuthorizationUrl({
			redirectUri: 'http://localhost:3000',
			clientId: clientId(),
			provider: 'authkit',
			organizationId: orgId,
		})
		expect(url.startsWith(`${baseUrl()}/user_management/authorize?`)).toBe(true)
	})

	it('authenticateWithRefreshToken re-scopes the session to the org; token carries internal_org_id', async () => {
		const result = await workos.userManagement.authenticateWithRefreshToken({
			clientId: clientId(),
			refreshToken: admin.refreshToken,
			organizationId: orgId,
		})
		admin.refreshToken = result.refreshToken
		expect(result.organizationId).toBe(orgId)
		expect(result.user.id).toBe(admin.id)
		const claims = await validateLikeRiptideApi(result.accessToken, workos.userManagement.getJwksUrl(clientId()))
		expect(claims).toMatchObject({
			sub: admin.id,
			org_id: orgId,
			internal_org_id: internalOrgId,
			role: 'admin',
			roles: ['admin'],
		})
		expect(claims.sid).toMatch(/^session_/)
		expect(decodeJwtPayload(result.accessToken).iss).toBe(`${baseUrl()}/user_management/${clientId()}`)
	})

	it('getUser / listUsers by email and by organization', async () => {
		const user = await workos.userManagement.getUser(admin.id)
		expect(user).toMatchObject({ id: admin.id, email: admin.email, object: 'user' })
		const byEmail = await workos.userManagement.listUsers({ email: admin.email.toUpperCase() })
		expect(byEmail.data.map((u) => u.id)).toEqual([admin.id])
		const byOrg = await (await workos.userManagement.listUsers({ organizationId: orgId })).autoPagination()
		expect(byOrg.map((u) => u.id)).toEqual([admin.id])
		await expect(workos.userManagement.getUser('user_01NOPE00000000000000000000')).rejects.toMatchObject({
			status: 404,
		})
	})

	it('invitations: send (no email; link returned), list, get, findByToken, duplicate/member errors, revoke', async () => {
		const invitee = uniqueEmail('invitee', 'invited.test')
		const invitation = await workos.userManagement.sendInvitation({
			email: invitee,
			organizationId: orgId,
			inviterUserId: admin.id,
			roleSlug: 'member',
			expiresInDays: 7,
		})
		expect(invitation).toMatchObject({
			email: invitee,
			state: 'pending',
			organizationId: orgId,
			roleSlug: 'member',
		})
		expect(invitation.acceptInvitationUrl).toBe(
			`${baseUrl()}/invitations/accept?invitation_token=${invitation.token}`,
		)

		const byOrg = await (await workos.userManagement.listInvitations({ organizationId: orgId })).autoPagination()
		expect(byOrg.map((i) => i.id)).toContain(invitation.id)
		const byEmail = await (await workos.userManagement.listInvitations({ email: invitee })).autoPagination()
		expect(byEmail.map((i) => i.id)).toEqual([invitation.id])
		expect((await workos.userManagement.getInvitation(invitation.id)).id).toBe(invitation.id)
		expect((await workos.userManagement.findInvitationByToken(invitation.token)).id).toBe(invitation.id)

		// riptide-api's invitations-create branches on these messages.
		await expect(
			workos.userManagement.sendInvitation({ email: invitee, organizationId: orgId, inviterUserId: admin.id }),
		).rejects.toThrow(/already invited/)
		await expect(
			workos.userManagement.sendInvitation({
				email: admin.email,
				organizationId: orgId,
				inviterUserId: admin.id,
			}),
		).rejects.toThrow(/already a member/)

		const revoked = await workos.userManagement.revokeInvitation(invitation.id)
		expect(revoked.state).toBe('revoked')
	})

	it('acceptInvitation activates the membership and emits a signed organization_membership.created webhook', async () => {
		const invitation = await workos.userManagement.sendInvitation({
			email: member.email,
			organizationId: orgId,
			roleSlug: 'member',
		})
		const accepted = await workos.userManagement.acceptInvitation(invitation.id)
		expect(accepted).toMatchObject({ state: 'accepted', acceptedUserId: member.id })
		const memberships = await (
			await workos.userManagement.listOrganizationMemberships({
				userId: member.id,
				organizationId: orgId,
				statuses: ['active'],
			})
		).autoPagination()
		expect(memberships).toHaveLength(1)

		// The API's /webhooks/workos handler: verifyWebhook(JSON.parse(body)) then getMembershipWebhookEvent.
		let deliveries: Array<{ body: string; signature: string }> = []
		for (let i = 0; i < 40; i++) {
			deliveries = await (await fetch(`http://127.0.0.1:${inject('webhookPort')}/__events`)).json()
			if (deliveries.some((d) => d.body.includes(member.id))) break
			await new Promise((r) => setTimeout(r, 100))
		}
		const delivery = deliveries.find(
			(d) => d.body.includes(member.id) && d.body.includes('organization_membership.created'),
		)!
		expect(delivery).toBeTruthy()
		const event = (await workos.webhooks.constructEvent({
			payload: JSON.parse(delivery.body),
			sigHeader: delivery.signature,
			secret: inject('webhookSecret'),
		})) as { event: string; data: { organizationId: string; userId: string } }
		expect(event.event).toBe('organization_membership.created')
		expect(event.data).toMatchObject({ organizationId: orgId, userId: member.id })
		await expect(
			workos.webhooks.constructEvent({
				payload: JSON.parse(delivery.body),
				sigHeader: delivery.signature,
				secret: 'wrong',
			}),
		).rejects.toThrow()
	})

	it('update / deactivate / reactivate / delete organization membership', async () => {
		const [membership] = await (
			await workos.userManagement.listOrganizationMemberships({
				userId: member.id,
				organizationId: orgId,
				statuses: ['active', 'inactive'],
				limit: 1,
			})
		).autoPagination()
		const updated = await workos.userManagement.updateOrganizationMembership(membership!.id, { roleSlug: 'admin' })
		expect(updated.role.slug).toBe('admin')
		expect((await workos.userManagement.deactivateOrganizationMembership(membership!.id)).status).toBe('inactive')
		const inactive = await (
			await workos.userManagement.listOrganizationMemberships({ organizationId: orgId, statuses: ['inactive'] })
		).autoPagination()
		expect(inactive.map((m) => m.id)).toEqual([membership!.id])
		expect((await workos.userManagement.reactivateOrganizationMembership(membership!.id)).status).toBe('active')
		await workos.userManagement.deleteOrganizationMembership(membership!.id)
		const after = await (
			await workos.userManagement.listOrganizationMemberships({
				userId: member.id,
				statuses: ['active', 'inactive', 'pending'],
			})
		).autoPagination()
		expect(after).toHaveLength(0)
	})

	it('organizationDomains create / delete', async () => {
		const domain = await workos.organizationDomains.createOrganizationDomain({
			domain: `extra-${Date.now()}.example`,
			organizationId: orgId,
		})
		expect(domain).toMatchObject({ organizationId: orgId, state: 'pending' })
		expect((await workos.organizations.getOrganization(orgId)).domains.map((d) => d.id)).toContain(domain.id)
		await workos.organizationDomains.deleteOrganizationDomain(domain.id)
		expect((await workos.organizations.getOrganization(orgId)).domains.map((d) => d.id)).not.toContain(domain.id)
	})

	it('user API keys as personal access tokens: create, list, validate, delete', async () => {
		const created = await workos.userManagement.createUserApiKey(admin.id, {
			organizationId: orgId,
			name: 'laptop',
			expiresAt: new Date(Date.now() + 7 * 86_400_000),
		})
		expect(created.value).toMatch(/^hlk_/)
		expect(created.obfuscatedValue.endsWith(created.value.slice(-4))).toBe(true)
		const listed = await (
			await workos.userManagement.listUserApiKeys(admin.id, { organizationId: orgId })
		).autoPagination()
		expect(listed.map((k) => k.id)).toContain(created.id)
		expect(listed[0]).not.toHaveProperty('value')

		const validation = await workos.apiKeys.createValidation({ value: created.value })
		expect(validation.apiKey?.owner).toEqual({ type: 'user', id: admin.id, organizationId: orgId })
		expect((await workos.apiKeys.createValidation({ value: 'hlk_nope' })).apiKey).toBeNull()

		await workos.apiKeys.deleteApiKey(created.id)
		expect((await workos.apiKeys.createValidation({ value: created.value })).apiKey).toBeNull()
	})

	it('adminPortal.generateLink is deliberately unsupported', async () => {
		await expect(
			workos.adminPortal.generateLink({ organization: orgId, intent: 'domain_verification' as never }),
		).rejects.toThrow(/not available/)
	})

	it('cursor pagination (list_metadata.after) works with small pages', async () => {
		const first = await workos.userManagement.listUsers({ limit: 1 })
		expect(first.data).toHaveLength(1)
		expect(first.listMetadata.after).toBe(first.data[0]!.id)
		const second = await workos.userManagement.listUsers({ limit: 1, after: first.listMetadata.after! })
		expect(second.data[0]!.id).not.toBe(first.data[0]!.id)
	})

	it('rejects a wrong API key with UnauthorizedException', async () => {
		const { WorkOS } = await import('@workos-inc/node')
		const bad = new WorkOS('sk_wrong', { apiHostname: '127.0.0.1', port: inject('port'), https: false })
		await expect(bad.userManagement.getUser(admin.id)).rejects.toMatchObject({ status: 401 })
	})
})
