/**
 * humanlayer-streams: the Durable Streams HTTP protocol on Durable Objects.
 *
 * Routes `/v1/stream/<path...>` to one SQLite-backed Durable Object per
 * stream path (`idFromName(pathname)`). Not publicly routed: callers reach it
 * through service bindings (`env.STREAMS.fetch(request)`).
 */
import type { Env } from './stream-object'

export { DurableStreamObject } from './stream-object'
export type { Env } from './stream-object'

const STREAM_PREFIX = '/v1/stream/'

const CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, PUT, DELETE, HEAD, OPTIONS',
	'access-control-allow-headers':
		'content-type, authorization, If-None-Match, Stream-Seq, Stream-TTL, Stream-Expires-At, Stream-Closed, Producer-Id, Producer-Epoch, Producer-Seq, Stream-Producer-Id, Stream-Producer-Epoch, Stream-Producer-Seq, Stream-Forked-From, Stream-Fork-Offset, Stream-Fork-Sub-Offset',
	'access-control-expose-headers':
		'stream-next-offset, stream-up-to-date, stream-cursor, stream-closed, stream-sse-data-encoding, producer-epoch, producer-seq, producer-expected-seq, producer-received-seq, etag, content-type, content-encoding, vary',
	'x-content-type-options': 'nosniff',
	'cross-origin-resource-policy': 'cross-origin',
} as const

function withCommonHeaders(response: Response): Response {
	// Re-wrap so headers are mutable; streaming bodies (SSE) pass through untouched.
	const wrapped = new Response(response.body, response)
	for (const [key, value] of Object.entries(CORS_HEADERS)) wrapped.headers.set(key, value)
	return wrapped
}

const plain = (status: number, body: string) =>
	withCommonHeaders(new Response(body, { status, headers: { 'content-type': 'text/plain' } }))

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname

		if (request.method === 'OPTIONS') return withCommonHeaders(new Response(null, { status: 204 }))
		if (path === '/healthz' || path === '/readyz') return plain(200, 'ok')
		if (!path.startsWith(STREAM_PREFIX) || path.length === STREAM_PREFIX.length) {
			return plain(404, 'Not found')
		}

		try {
			const stub = env.STREAMS.get(env.STREAMS.idFromName(path))
			return withCommonHeaders(await stub.fetch(request))
		} catch (err) {
			console.error('stream request failed', request.method, path, err)
			return plain(500, 'Internal server error')
		}
	},
} satisfies ExportedHandler<Env>
