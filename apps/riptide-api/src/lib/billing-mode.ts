import { isBillingEnforcementEnabled } from './environment'
import type { IStripeService } from './stripe-service'

/**
 * "Billing off": a deployment without a Stripe account.
 *
 * Billing is off when `STRIPE_SECRET_KEY` is unset AND `IS_BILLING_ENFORCEMENT_ENABLED` is
 * `false`. The composition root (`app.ts`) then injects {@link createBillingDisabledStripeService}
 * instead of the real Stripe client, and every code path that would otherwise reach Stripe as a
 * side effect of normal product use asks {@link isBillingDisabled} first and degrades to a no-op /
 * "no billing" answer. The decision is carried by the injected service rather than re-read from
 * the environment at each call site, so tests (which inject mock Stripe services) are unaffected.
 *
 * A missing key while enforcement is on is a misconfiguration: {@link isBillingDisabled} throws
 * {@link BillingMisconfiguredError} at the point of use instead of silently running unbilled.
 */
export const BILLING_NOT_CONFIGURED_MESSAGE = 'Billing is not configured on this deployment (no Stripe account).'

export class BillingNotConfiguredError extends Error {
	constructor(operation: string) {
		super(`${BILLING_NOT_CONFIGURED_MESSAGE} Attempted Stripe operation: ${operation}`)
		this.name = 'BillingNotConfiguredError'
	}
}

export class BillingMisconfiguredError extends Error {
	constructor() {
		super(
			'STRIPE_SECRET_KEY is not set but IS_BILLING_ENFORCEMENT_ENABLED is true. Either configure Stripe or set IS_BILLING_ENFORCEMENT_ENABLED=false to run without billing.',
		)
		this.name = 'BillingMisconfiguredError'
	}
}

// Identity check (not a property probe): probing a lazily-constructed real client would build it.
const disabledServices = new WeakSet<object>()

export function isStripeConfigured(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.STRIPE_SECRET_KEY?.trim())
}

/**
 * An {@link IStripeService} for deployments without Stripe. Every member access other than the
 * brand throws {@link BillingNotConfiguredError}, so a call site that forgot to check
 * {@link isBillingDisabled} fails clearly instead of reaching Stripe with no credentials.
 */
export function createBillingDisabledStripeService(): IStripeService {
	const service = new Proxy({} as IStripeService, {
		get(_target, property) {
			// Not a thenable / not specially inspectable.
			if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined
			throw new BillingNotConfiguredError(String(property))
		},
	})
	disabledServices.add(service)
	return service
}

/**
 * Whether `stripe` is the billing-disabled service. Throws {@link BillingMisconfiguredError} when it
 * is but billing enforcement is enabled (no key + enforcement on must fail loudly).
 */
export function isBillingDisabled(stripe: Partial<IStripeService>): boolean {
	if (!disabledServices.has(stripe)) return false
	if (isBillingEnforcementEnabled()) throw new BillingMisconfiguredError()
	return true
}

/**
 * Environment-level form for wiring that has no injected Stripe service (the Effect Stripe layers).
 * Never throws: a misconfiguration (no key, enforcement on) is reported as "not off", so the real
 * layer is attempted and fails where it is used.
 */
export function isBillingOffInEnvironment(): boolean {
	return !isStripeConfigured() && process.env.IS_BILLING_ENFORCEMENT_ENABLED === 'false'
}
