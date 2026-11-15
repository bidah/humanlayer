/**
 * Defer constructing an integration client until it is first used.
 *
 * On Cloudflare Workers, module scope must not perform I/O and the Worker has to boot even when an
 * optional integration (Stripe, Resend, Jira, Linear, S3...) is not configured; constructing those
 * clients eagerly at import would throw `Missing required environment variable` and take down
 * every route. With `eager: true` (Node) the instance is built immediately, preserving the
 * existing fail-fast startup behaviour.
 *
 * The returned proxy forwards every property access to the instance, binding methods to it, so
 * call sites are unchanged. A construction failure surfaces on the first access, in the route that
 * needed the integration.
 */
export function lazyInstance<T extends object>(create: () => T, options: { readonly eager: boolean }): T {
	if (options.eager) return create()
	let instance: T | undefined
	const resolve = (): T => {
		instance ??= create()
		return instance
	}
	return new Proxy({} as T, {
		get(_target, property) {
			const target = resolve()
			const value = Reflect.get(target, property, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
		set(_target, property, value) {
			return Reflect.set(resolve(), property, value)
		},
		has(_target, property) {
			return Reflect.has(resolve(), property)
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(resolve())
		},
	})
}
