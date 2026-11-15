import { Effect } from 'effect'
import type { Hono } from 'hono'

import { appRuntime } from '../effects/app-runtime'
import { BillingCheckoutCompletionService } from '../effects/services/billing-checkout-completion/billing-checkout-completion.service'
import { BILLING_NOT_CONFIGURED_MESSAGE } from '../lib/billing-mode'

export function registerBillingCheckoutCompletionRoutes(
	app: Hono,
	deps: { readonly billingDisabled?: () => boolean } = {},
): void {
	// Billing off (no Stripe account): Stripe Checkout never redirects here.
	app.use('/billing/checkout/*', async (c, next) => {
		if (deps.billingDisabled?.()) return c.json({ error: BILLING_NOT_CONFIGURED_MESSAGE }, 503)
		await next()
	})

	app.get('/billing/checkout/finalize-starter-to-pro-upgrade', async (c) => {
		const result = await appRuntime.runPromise(
			Effect.gen(function* () {
				const service = yield* BillingCheckoutCompletionService
				return yield* service.finalizeStarterToProUpgradeFromRedirect({ url: c.req.url })
			}),
		)
		return c.redirect(result.redirectUrl)
	})

	app.get('/billing/checkout/resync', async (c) => {
		const result = await appRuntime.runPromise(
			Effect.gen(function* () {
				const service = yield* BillingCheckoutCompletionService
				return yield* service.resyncFromCheckoutRedirect({ url: c.req.url })
			}),
		)
		return c.redirect(result.redirectUrl)
	})
}
