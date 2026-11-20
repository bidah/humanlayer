import { getOptionalWorkerEnv } from './worker-env'

/**
 * Single fetch seam for Durable Streams on Cloudflare.
 *
 * The API talks to the streams server at `DURABLE_STREAMS_ORIGIN` through both
 * `@durable-streams/client` and Effect's FetchHttpClient, which both call `globalThis.fetch`. On
 * Cloudflare that server is the `human-flare-streams` Worker, reachable only through the `STREAMS`
 * service binding, so requests whose origin matches the configured streams origin are dispatched
 * to `env.STREAMS.fetch` (same `/v1/stream/...` path and query) instead of the public internet.
 * Every other request goes to the original fetch untouched.
 *
 * Installed by the Worker entry only; Node never patches fetch.
 */
export function installStreamsFetchSeam(): void {
	const originalFetch = globalThis.fetch
	const patched = function fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		const streams = getOptionalWorkerEnv()?.STREAMS
		const configured = process.env.DURABLE_STREAMS_ORIGIN
		if (streams && configured) {
			const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
			if (sameOrigin(url, configured)) {
				const request =
					input instanceof Request
						? init === undefined
							? input
							: new Request(input, init)
						: new Request(url, init)
				return streams.fetch(request)
			}
		}
		return originalFetch(input, init)
	}
	globalThis.fetch = patched as typeof globalThis.fetch
}

function sameOrigin(url: string, configuredOrigin: string): boolean {
	try {
		return new URL(url).origin === new URL(configuredOrigin).origin
	} catch {
		return false
	}
}
