/**
 * `fetch` replacement for the Cloudflare Worker build: requests whose origin matches a configured
 * upstream go to that upstream's service binding instead of the public internet. Everything else
 * (e.g. the WorkOS JWKS endpoint) falls through to the global `fetch`.
 *
 * Service bindings accept an ordinary `Request`; only the path and query matter to the bound
 * Worker, so the hostname in ELECTRIC_SHAPE_URL / DURABLE_STREAMS_ORIGIN is just a routing key.
 * Responses are returned as-is, so upstream bodies (Electric long-polls, Durable Streams SSE)
 * stream through without buffering.
 */

/** Minimal structural type for a Cloudflare service binding (avoids pulling in global Worker types). */
export type ServiceBinding = {
	fetch: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
}

export type UpstreamRoute = {
	/** Name used in error messages, e.g. `ELECTRIC`. */
	readonly bindingName: string
	/** Origin (scheme + host[:port]) whose requests are routed to the binding. */
	readonly origin: string
	/** The binding. Undefined when the Worker was deployed without it. */
	readonly binding: ServiceBinding | undefined
}

type FetchInput = Request | string | URL

export class UpstreamBindingMissingError extends Error {
	constructor(bindingName: string, origin: string) {
		super(`Service binding ${bindingName} is not configured; cannot reach ${origin}`)
		this.name = 'UpstreamBindingMissingError'
	}
}

export function makeBindingFetch(
	routes: readonly UpstreamRoute[],
	fallback: (input: FetchInput, init?: RequestInit) => Promise<Response> = (input, init) =>
		globalThis.fetch(input, init),
): typeof globalThis.fetch {
	const byOrigin = new Map(routes.map((route) => [new URL(route.origin).origin, route]))

	const bindingFetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString())
		const route = byOrigin.get(url.origin)
		if (!route) return fallback(input, init)
		if (!route.binding) throw new UpstreamBindingMissingError(route.bindingName, route.origin)
		return route.binding.fetch(input instanceof Request ? new Request(input, init) : new Request(url.href, init))
	}

	return Object.assign(bindingFetch, { preconnect: () => {} }) as typeof globalThis.fetch
}
