import { randomUUID } from 'node:crypto'

import { organizations } from '@humanlayer/db/tables/organizations'
import { call, ORPCError } from '@orpc/server'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import {
	BILLING_NOT_CONFIGURED_MESSAGE,
	BillingMisconfiguredError,
	BillingNotConfiguredError,
	createBillingDisabledStripeService,
} from '../../src/lib/billing-mode'
import { billingInfoProcedure } from '../../src/orpc/api/auth/admin/billing-info'
import { adminDeactivateUserProcedure } from '../../src/orpc/api/auth/admin/users-deactivate'
import { adminReactivateUserProcedure } from '../../src/orpc/api/auth/admin/users-reactivate'
import { adminRemoveUserProcedure } from '../../src/orpc/api/auth/admin/users-remove'
import { adminUpdateUserRoleProcedure } from '../../src/orpc/api/auth/admin/users-update-role'
import { createOrganizationProcedure } from '../../src/orpc/api/auth/user/organizations-create'
import { applyPromotionCodeProcedure } from '../../src/orpc/api/billing/apply-promotion-code'
import { createCheckoutSessionProcedure } from '../../src/orpc/api/billing/create-checkout-session'
import { createPortalSessionProcedure } from '../../src/orpc/api/billing/create-portal-session'
import { downgradeToStarterProcedure } from '../../src/orpc/api/billing/downgrade-to-starter'
import { finalizeUpgradeProcedure } from '../../src/orpc/api/billing/finalize-upgrade'
import { resyncSeatsProcedure } from '../../src/orpc/api/billing/resync-seats'
import { startUpgradeProcedure } from '../../src/orpc/api/billing/start-upgrade'
import { syncCheckoutSessionProcedure } from '../../src/orpc/api/billing/sync-checkout-session'
import { registerBillingCheckoutCompletionRoutes } from '../../src/routes/billing-checkout-completion'
import { registerStripeWebhookRoute } from '../../src/webhooks/stripe'
import { billingKvLayerFromTestService, TestBillingKvService } from '../fixtures/billing-kv-runtime'
import {
	createMockApiAuth,
	createMockApiContext,
	createMockApiContextNoOrg,
	createMockWorkosService,
	StatefulMockWorkosService,
} from '../mocks'
import { createDefaultTestEffectRuntime } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

/**
 * "Billing off": no STRIPE_SECRET_KEY and IS_BILLING_ENFORCEMENT_ENABLED=false. app.ts then
 * injects the billing-disabled Stripe service; every test here uses it and asserts no Stripe
 * access happens (any member access on that service throws BillingNotConfiguredError).
 */
describe('billing off (no Stripe account)', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	const originalEnforcement = process.env.IS_BILLING_ENFORCEMENT_ENABLED

	beforeAll(async () => {
		const testDb = await createTestDb('billing_off')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
	}, 60000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	afterEach(() => {
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = originalEnforcement
	})

	const noOrgAuth = {
		userId: 'user_billing_off_creator',
		role: '',
		roles: [] as string[],
		permissions: [] as string[],
		entitlements: [] as string[],
		sessionId: 'test-session',
	}

	async function insertOrganization(stripeCustomerId: string | null = null) {
		const workosOrganizationId = `workos_${randomUUID()}`
		const [organization] = await db
			.insert(organizations)
			.values({
				name: 'Billing Off Org',
				workos_organization_id: workosOrganizationId,
				stripe_customer_id: stripeCustomerId,
			})
			.returning()
		if (!organization) throw new Error('Unable to insert billing-off organization')
		return { organizationId: organization.id, workosOrganizationId }
	}

	function adminContext(organizationId: string, workosOrganizationId: string, workos = createMockWorkosService()) {
		return createMockApiContext({
			auth: createMockApiAuth({
				userId: 'user_admin',
				organizationId,
				workosOrganizationId,
				role: 'admin',
				roles: ['admin'],
			}),
			services: {
				workos,
				db,
				dbReadReplica: db,
				stripe: createBillingDisabledStripeService(),
				effectRuntime: createDefaultTestEffectRuntime({
					billingKv: billingKvLayerFromTestService(new TestBillingKvService()),
				}),
			},
		})
	}

	test('the billing-disabled Stripe service throws on any use', () => {
		const stripe = createBillingDisabledStripeService()
		expect(() => stripe.ensureStripeCustomerForOrg).toThrow(BillingNotConfiguredError)
		expect(() => stripe.prices).toThrow(BillingNotConfiguredError)
	})

	test('organizations.create succeeds with no Stripe calls and does not cap initial invites', async () => {
		const workos = new StatefulMockWorkosService()
		workos.addUser({ id: noOrgAuth.userId, email: 'creator@humanlayer.dev' })
		const inviteEmails = ['a@example.org', 'b@example.org', 'c@example.org', 'd@example.org', 'e@example.org']

		const result = await call(
			createOrganizationProcedure,
			{ name: 'Billing Off Created Org', eulaAccepted: true, inviteEmails },
			{
				context: createMockApiContextNoOrg({
					auth: noOrgAuth,
					services: { workos, db, dbReadReplica: db, stripe: createBillingDisabledStripeService() },
				}),
			},
		)

		expect(result.stripeCustomerId).toBeUndefined()
		expect(result.failedInvites).toEqual([])
		const [row] = await db.select().from(organizations).where(eq(organizations.id, result.organizationId))
		expect(row?.stripe_customer_id).toBeNull()
		const workosOrg = workos._organizations.get(result.workosOrganizationId)
		expect(workosOrg?.stripeCustomerId ?? null).toBeNull()
		// Regression: the sync proxy authorizes on the `internal_org_id` claim, which the identity
		// provider derives from this metadata. It used to be written only inside the Stripe block.
		expect(workosOrg?.metadata).toEqual({ internal_org_id: result.organizationId })
		const membership = Array.from(workos._memberships.values()).find((m) => m.userId === noOrgAuth.userId)
		expect(membership?.role.slug).toBe('admin')
	})

	test('organizations.create fails before any side effect when the key is missing but enforcement is on', async () => {
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'true'
		const workos = new StatefulMockWorkosService()
		workos.addUser({ id: noOrgAuth.userId, email: 'creator@humanlayer.dev' })

		await expect(
			call(
				createOrganizationProcedure,
				{ name: 'Misconfigured Billing Org', eulaAccepted: true },
				{
					context: createMockApiContextNoOrg({
						auth: noOrgAuth,
						services: { workos, db, dbReadReplica: db, stripe: createBillingDisabledStripeService() },
					}),
				},
			),
		).rejects.toBeInstanceOf(BillingMisconfiguredError)
		expect(workos._organizations.size).toBe(0)
		const rows = await db.select().from(organizations).where(eq(organizations.name, 'Misconfigured Billing Org'))
		expect(rows).toHaveLength(0)
	})

	test('auth.admin.billing.info reports "not linked" without Stripe, even with a stored customer id', async () => {
		const { organizationId, workosOrganizationId } = await insertOrganization('cus_stale_from_import')
		const workos = createMockWorkosService({
			countActiveOrganizationMemberships: async () => 2,
			countPendingInvitations: async () => 1,
		})
		const result = await call(
			billingInfoProcedure,
			{},
			{
				context: adminContext(organizationId, workosOrganizationId, workos),
			},
		)
		expect(result).toMatchObject({
			rolloutDisplayState: 'not_linked',
			tier: null,
			subscriptionStatus: null,
			stripeCustomerId: null,
			subscriptionId: null,
			nextInvoice: null,
			paymentMethod: null,
			activeSeatCount: 2,
			pendingInvitationCount: 1,
		})
	})

	const stripeOnlyProcedures = [
		['billing.applyPromotionCode', applyPromotionCodeProcedure, { code: 'PROMO' }],
		[
			'billing.createCheckoutSession',
			createCheckoutSessionProcedure,
			{ successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/cancel' },
		],
		['billing.createPortalSession', createPortalSessionProcedure, { returnUrl: 'https://app.example/billing' }],
		['billing.downgradeToStarter', downgradeToStarterProcedure, {}],
		['billing.finalizeUpgrade', finalizeUpgradeProcedure, {}],
		['billing.resyncSeats', resyncSeatsProcedure, {}],
		[
			'billing.startUpgrade',
			startUpgradeProcedure,
			{ successUrl: 'https://app.example/ok', cancelUrl: 'https://app.example/cancel' },
		],
		['billing.syncCheckoutSession', syncCheckoutSessionProcedure, {}],
	] as const

	test.each(stripeOnlyProcedures)(
		'%s returns a typed "billing not configured" error',
		async (_name, procedure, input) => {
			const { organizationId, workosOrganizationId } = await insertOrganization()
			const error = await call(procedure as any, input, {
				context: adminContext(organizationId, workosOrganizationId),
			}).catch((caught: unknown) => caught)
			expect(error).toBeInstanceOf(ORPCError)
			expect((error as ORPCError<string, unknown>).code).toBe('SERVICE_UNAVAILABLE')
			expect((error as ORPCError<string, unknown>).status).toBe(503)
			expect((error as ORPCError<string, unknown>).message).toBe(BILLING_NOT_CONFIGURED_MESSAGE)
		},
	)

	test('membership mutations succeed and skip seat sync', async () => {
		const { organizationId, workosOrganizationId } = await insertOrganization()
		const workos = new StatefulMockWorkosService()
		workos.addOrganization({ id: workosOrganizationId, name: 'Billing Off Org' })
		for (const id of ['user_admin', 'user_admin_2', 'user_member', 'user_inactive']) {
			workos.addUser({ id, email: `${id}@example.org` })
		}
		workos.addMembership({
			id: 'om_a',
			userId: 'user_admin',
			organizationId: workosOrganizationId,
			role: { slug: 'admin' },
		})
		workos.addMembership({
			id: 'om_a2',
			userId: 'user_admin_2',
			organizationId: workosOrganizationId,
			role: { slug: 'admin' },
		})
		workos.addMembership({
			id: 'om_m',
			userId: 'user_member',
			organizationId: workosOrganizationId,
			role: { slug: 'member' },
		})
		workos.addMembership({
			id: 'om_i',
			userId: 'user_inactive',
			organizationId: workosOrganizationId,
			role: { slug: 'member' },
			status: 'inactive',
		})
		const context = adminContext(organizationId, workosOrganizationId, workos)

		await expect(
			call(adminUpdateUserRoleProcedure, { userId: 'user_member', roleSlug: 'admin' }, { context }),
		).resolves.toMatchObject({ success: true })
		await expect(call(adminReactivateUserProcedure, { userId: 'user_inactive' }, { context })).resolves.toEqual({
			success: true,
		})
		await expect(
			call(adminDeactivateUserProcedure, { userId: 'user_admin_2' }, { context }),
		).resolves.toMatchObject({ success: true })
		await expect(call(adminRemoveUserProcedure, { userId: 'user_member' }, { context })).resolves.toEqual({
			success: true,
		})
	})

	test('Stripe webhook and checkout redirect routes answer 503 instead of reaching Stripe', async () => {
		const app = new Hono()
		const appRuntime = createDefaultTestEffectRuntime()
		registerStripeWebhookRoute(app, { appRuntime, billingDisabled: () => true })
		registerBillingCheckoutCompletionRoutes(app, { billingDisabled: () => true })

		const webhook = await app.request('/webhooks/stripe', {
			method: 'POST',
			headers: { 'stripe-signature': 't=1,v1=x' },
			body: '{}',
		})
		expect(webhook.status).toBe(503)
		expect(await webhook.json()).toEqual({ error: BILLING_NOT_CONFIGURED_MESSAGE })

		const redirect = await app.request('/billing/checkout/resync?session_id=cs_1&client=web')
		expect(redirect.status).toBe(503)
	})
})
