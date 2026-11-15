import { Cause, Effect, Layer } from 'effect'
import type * as Context from 'effect/Context'

import { isCloudflareWorker } from '../platform/runtime'

/**
 * Raised (as a defect) when code calls an integration this deployment has not configured.
 */
export class IntegrationNotConfiguredError extends Error {
	constructor(
		readonly integration: string,
		readonly reason: string,
	) {
		super(`${integration} is not configured on this deployment (${reason})`)
		this.name = 'IntegrationNotConfiguredError'
	}
}

/**
 * A service value whose every method fails with {@link IntegrationNotConfiguredError}. Property
 * reads return functions so construction-time destructuring does not throw; only calls fail.
 */
function unconfiguredService(integration: string, reason: string): never {
	const error = new IntegrationNotConfiguredError(integration, reason)
	return new Proxy(
		{},
		{
			get(_target, property) {
				// Not a thenable, not inspectable as anything special.
				if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') return undefined
				return () => Effect.die(error)
			},
		},
	) as never
}

const summarize = (cause: Cause.Cause<unknown>): string => {
	const text =
		Cause.pretty(cause)
			.split('\n')
			.slice(0, 2)
			.map((line) => line.trim())
			.join(' ') || 'layer construction failed'
	return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * On Cloudflare Workers, an optional integration whose layer cannot be built (typically missing
 * Config such as STRIPE_SECRET_KEY / SLACK_CLIENT_ID / GITHUB_APP_ID / RESEND_API_KEY) is replaced
 * by stubs that fail when used, so the shared runtime still builds and only the routes that need
 * that integration fail with a clear error. On Node the layer is returned unchanged, preserving
 * the existing fail-fast startup.
 *
 * `tags` must list every service the layer outputs.
 */
export function optionalIntegration<A, E, R>(
	integration: string,
	layer: Layer.Layer<A, E, R>,
	tags: ReadonlyArray<Context.Key<unknown, unknown>>,
	options: {
		/**
		 * Deliberately switched off on this deployment (e.g. billing off: no STRIPE_SECRET_KEY): the
		 * stubs are used on every runtime, Node included, without attempting to build the layer.
		 */
		readonly disabled?: () => boolean
	} = {},
): Layer.Layer<A, E, R> {
	const stubLayer = (reason: string) =>
		Layer.mergeAll(
			...(tags.map((tag) => Layer.succeed(tag, unconfiguredService(integration, reason))) as [
				Layer.Layer<unknown>,
				...Array<Layer.Layer<unknown>>,
			]),
		)
	const configured = isCloudflareWorker()
		? layer.pipe(
				Layer.catchCause((cause) =>
					Layer.unwrap(
						Effect.gen(function* () {
							const reason = summarize(cause)
							yield* Effect.logWarning(`${integration} integration disabled: ${reason}`)
							return stubLayer(reason)
						}),
					),
				),
			)
		: layer
	if (!options.disabled) return configured as Layer.Layer<A, E, R>
	const disabled = options.disabled
	return Layer.unwrap(
		Effect.sync(() => (disabled() ? stubLayer('disabled on this deployment') : configured)),
	) as Layer.Layer<A, E, R>
}
