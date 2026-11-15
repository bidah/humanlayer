import { Effect, Layer } from 'effect'
import * as Context from 'effect/Context'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { optionalIntegration } from '../effects/optional-integration'
import {
	BillingMisconfiguredError,
	createBillingDisabledStripeService,
	isBillingDisabled,
	isBillingOffInEnvironment,
	isStripeConfigured,
} from './billing-mode'
import { type SeatSyncDependencies, syncSeatsAfterMembershipChange } from './seat-sync'

const env = { ...process.env }

afterEach(() => {
	process.env = { ...env }
})

describe('billing mode', () => {
	it('treats a missing or blank STRIPE_SECRET_KEY as unconfigured', () => {
		expect(isStripeConfigured({})).toBe(false)
		expect(isStripeConfigured({ STRIPE_SECRET_KEY: '  ' })).toBe(false)
		expect(isStripeConfigured({ STRIPE_SECRET_KEY: 'sk_test_x' })).toBe(true)
	})

	it('identifies the billing-disabled service by identity, never probing real clients', () => {
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'false'
		const real = new Proxy(
			{},
			{
				get: () => {
					throw new Error('must not be probed')
				},
				has: () => {
					throw new Error('must not be probed')
				},
			},
		)
		expect(isBillingDisabled(real)).toBe(false)
		expect(isBillingDisabled(createBillingDisabledStripeService())).toBe(true)
	})

	it('fails loudly at the point of use when the key is missing but enforcement is on', () => {
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'true'
		expect(() => isBillingDisabled(createBillingDisabledStripeService())).toThrow(BillingMisconfiguredError)
	})

	it('reports billing off from the environment only for "no key + enforcement false"', () => {
		delete process.env.STRIPE_SECRET_KEY
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'false'
		expect(isBillingOffInEnvironment()).toBe(true)
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'true'
		expect(isBillingOffInEnvironment()).toBe(false)
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'false'
		process.env.STRIPE_SECRET_KEY = 'sk_test_x'
		expect(isBillingOffInEnvironment()).toBe(false)
	})
})

describe('syncSeatsAfterMembershipChange', () => {
	it('is a no-op that touches neither the database nor WorkOS when billing is off', async () => {
		process.env.IS_BILLING_ENFORCEMENT_ENABLED = 'false'
		const countActiveOrganizationMemberships = vi.fn()
		const db = new Proxy(
			{},
			{
				get: () => {
					throw new Error('database must not be used')
				},
			},
		)
		const result = await syncSeatsAfterMembershipChange(
			{ organizationId: 'org_1', reason: 'first_party_membership_mutation' },
			{
				workosService: { countActiveOrganizationMemberships },
				stripeService: createBillingDisabledStripeService(),
				db,
			} as unknown as SeatSyncDependencies,
		)
		expect(result).toEqual({
			organizationId: 'org_1',
			reason: 'first_party_membership_mutation',
			skipped: 'billing_not_configured',
		})
		expect(countActiveOrganizationMemberships).not.toHaveBeenCalled()
	})
})

class Probe extends Context.Service<Probe, { readonly ping: () => Effect.Effect<string> }>()('BillingModeProbe') {}

describe('optionalIntegration({ disabled })', () => {
	it('provides failing stubs without building the layer when disabled', async () => {
		const build = vi.fn(() => Probe.of({ ping: () => Effect.succeed('real') }))
		const layer = optionalIntegration('Probe', Layer.sync(Probe, build), [Probe], { disabled: () => true })
		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const probe = yield* Probe
				return yield* probe.ping()
			}).pipe(Effect.provide(layer)),
		)
		expect(build).not.toHaveBeenCalled()
		expect(exit._tag).toBe('Failure')
	})

	it('builds the real layer when not disabled', async () => {
		const layer = optionalIntegration(
			'Probe',
			Layer.succeed(Probe, Probe.of({ ping: () => Effect.succeed('real') })),
			[Probe],
			{ disabled: () => false },
		)
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const probe = yield* Probe
				return yield* probe.ping()
			}).pipe(Effect.provide(layer)),
		)
		expect(result).toBe('real')
	})
})
