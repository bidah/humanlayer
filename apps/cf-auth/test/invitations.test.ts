// Invitations without email delivery: the link comes back from sendInvitation (and is listed for org
// admins on /invitations); opening it lets an otherwise non-allowlisted email sign up and joins the org.
import type { WorkOS } from '@workos-inc/node'
import { beforeAll, describe, expect, it } from 'vitest'

import { Browser, authorizeUrlFor, parseForms, pkcePair, signUpUser, uniqueEmail, workosV10 } from './helpers'

const PASSWORD = 'correct horse battery staple'

describe('invitations', () => {
	let workos: WorkOS
	let orgId: string
	let adminEmail: string
	let adminId: string

	beforeAll(async () => {
		workos = workosV10()
		adminEmail = uniqueEmail('inv-admin')
		const { tokens } = await signUpUser(adminEmail, PASSWORD)
		adminId = tokens.user.id
		orgId = (await workos.organizations.createOrganization({ name: 'Invite Co' })).id
		await workos.userManagement.createOrganizationMembership({
			userId: adminId,
			organizationId: orgId,
			roleSlug: 'admin',
		})
	})

	it('a new user signs up through the acceptance link and joins the org', async () => {
		const invitee = uniqueEmail('newbie', 'invited.test') // not allowlisted
		const invitation = await workos.userManagement.sendInvitation({
			email: invitee,
			organizationId: orgId,
			inviterUserId: adminId,
			roleSlug: 'member',
		})

		const browser = new Browser()
		const page = await browser.get(invitation.acceptInvitationUrl)
		const html = await page.text()
		expect(html).toContain('Join Invite Co')
		const form = parseForms(html).find((f) => f.fields.intent === 'sign_up')!
		expect(html).toMatch(/name="email"[^>]*readonly/)
		const res = await browser.post(form.action, {
			...form.fields,
			email: invitee,
			password: PASSWORD,
			first_name: 'New',
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('has joined the organization')

		expect((await workos.userManagement.getInvitation(invitation.id)).state).toBe('accepted')
		const [user] = (await workos.userManagement.listUsers({ email: invitee })).data
		expect(user).toMatchObject({ emailVerified: true, firstName: 'New' })
		const memberships = await workos.userManagement.listOrganizationMemberships({
			userId: user!.id,
			organizationId: orgId,
		})
		expect(memberships.data[0]).toMatchObject({ status: 'active', role: { slug: 'member' } })

		// The link is now spent, and the email is no longer eligible to sign up again.
		expect((await new Browser().get(invitation.acceptInvitationUrl)).status).toBe(410)
		const again = new Browser()
		const { challenge } = await pkcePair()
		const signup = await again.get(
			authorizeUrlFor({
				redirect_uri: 'http://localhost:5174/auth/callback',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				screen_hint: 'sign-up',
			}),
		)
		const retry = await again.submit(await signup.text(), 'sign_up', { email: invitee, password: PASSWORD })
		expect(retry.status).toBe(403) // same answer as for a stranger: no account-existence leak
	})

	it('an existing user accepts by signing in on the link', async () => {
		const existing = uniqueEmail('existing')
		const { tokens } = await signUpUser(existing, PASSWORD)
		const invitation = await workos.userManagement.sendInvitation({ email: existing, organizationId: orgId })
		const browser = new Browser()
		const html = await (await browser.get(invitation.acceptInvitationUrl)).text()
		const res = await browser.submit(html, 'sign_in', { email: existing, password: PASSWORD })
		expect(res.status).toBe(200)
		const memberships = await workos.userManagement.listOrganizationMemberships({
			userId: tokens.user.id,
			organizationId: orgId,
		})
		expect(memberships.data).toHaveLength(1)
	})

	it('an invitation token cannot be used to sign up a different email', async () => {
		const invitation = await workos.userManagement.sendInvitation({
			email: uniqueEmail('target', 'invited.test'),
			organizationId: orgId,
		})
		const browser = new Browser()
		const { challenge } = await pkcePair()
		const page = await browser.get(
			authorizeUrlFor({
				redirect_uri: 'http://localhost:5174/auth/callback',
				code_challenge: challenge,
				code_challenge_method: 'S256',
				invitation_token: invitation.token,
			}),
		)
		const res = await browser.submit(await page.text(), 'sign_up', {
			email: uniqueEmail('other', 'invited.test'),
			password: PASSWORD,
		})
		expect(res.status).toBe(400)
		expect(await res.text()).toContain('sent to a different email address')
	})

	it('org admins can list pending invitation links on /invitations', async () => {
		const pending = await workos.userManagement.sendInvitation({
			email: uniqueEmail('pending', 'invited.test'),
			organizationId: orgId,
		})
		const browser = new Browser()
		const signIn = await (await browser.get('/invitations')).text()
		const res = await browser.submit(signIn, 'sign_in', { email: adminEmail, password: PASSWORD })
		expect(res.status).toBe(303)
		const html = await (await browser.get('/invitations')).text()
		expect(html).toContain('Invite Co')
		expect(html).toContain(pending.acceptInvitationUrl.replace(/&/g, '&amp;'))
		expect(html).toContain(pending.email)

		// A non-admin member sees no organizations' invitations.
		const memberEmail = uniqueEmail('plain')
		const { tokens } = await signUpUser(memberEmail, PASSWORD)
		await workos.userManagement.createOrganizationMembership({
			userId: tokens.user.id,
			organizationId: orgId,
			roleSlug: 'member',
		})
		const other = new Browser()
		await other.submit(await (await other.get('/invitations')).text(), 'sign_in', {
			email: memberEmail,
			password: PASSWORD,
		})
		const memberView = await (await other.get('/invitations')).text()
		expect(memberView).toContain('not an admin')
		expect(memberView).not.toContain(pending.email)
	})
})
