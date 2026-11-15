/**
 * Stand-in for `undici` in the Cloudflare Worker build (aliased in wrangler.jsonc).
 *
 * The Node upstream layer (lib/effect/pooled-http-client.ts and friends) is still reachable by
 * import because the ElectricProxyHttpClient / DurableStreamsHttpClient service tags live next to
 * their undici-backed Live layers. The Worker provides those tags with fetch-based layers
 * (worker/runtime.ts) and never builds the undici ones, so these exports only need to exist.
 * Anything that does call them is a wiring bug and fails loudly.
 */
const unavailable = (name: string) => () => {
	throw new Error(`undici.${name} is not available in the Cloudflare Worker build`)
}

export class Pool {
	constructor() {
		unavailable('Pool')()
	}
}
export const buildConnector = unavailable('buildConnector')
export const request = unavailable('request')
