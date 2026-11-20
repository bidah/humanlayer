/**
 * Local stand-in for the `human-flare-streams` Worker (Durable Streams protocol), used only by
 * `wrangler dev` smoke tests of the human-flare-sync Worker. Minimal, in-memory, single isolate:
 *
 * - PUT    /v1/stream/<path>             create (201, or 200 if it exists)
 * - POST   /v1/stream/<path>             append body, 204 (exercises the null-body-status path)
 * - GET    /v1/stream/<path>             whole stream as one body, Stream-Next-Offset header
 * - GET    /v1/stream/<path>?live=sse    text/event-stream, SSE_EVENTS events SSE_INTERVAL_MS apart
 * - HEAD   /v1/stream/<path>             headers only
 *
 * Every response carries x-stub-* headers describing what the proxy forwarded.
 */
type Env = { SSE_EVENTS?: string; SSE_INTERVAL_MS?: string }

const streams = new Map<string, { contentType: string; chunks: Uint8Array[] }>()

function concat(chunks: Uint8Array[]) {
	const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.length
	}
	return out
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		if (!url.pathname.startsWith('/v1/stream/')) return new Response('not found', { status: 404 })
		const key = url.pathname
		const seen = {
			'x-stub-path': url.pathname,
			'x-stub-method': request.method,
			'x-stub-saw-authorization': request.headers.has('authorization') ? 'yes' : 'no',
			'x-stub-content-type': request.headers.get('content-type') ?? '',
		}

		if (request.method === 'PUT') {
			const existed = streams.has(key)
			if (!existed)
				streams.set(key, { contentType: request.headers.get('content-type') ?? 'application/json', chunks: [] })
			return new Response(null, { status: existed ? 200 : 201, headers: { ...seen, 'stream-next-offset': '0' } })
		}

		const stream = streams.get(key)
		if (!stream) return new Response('stream not found', { status: 404, headers: seen })

		if (request.method === 'POST') {
			stream.chunks.push(new Uint8Array(await request.arrayBuffer()))
			return new Response(null, {
				status: 204,
				headers: { ...seen, 'stream-next-offset': String(stream.chunks.length) },
			})
		}

		if (request.method === 'GET' && url.searchParams.get('live') === 'sse') {
			const events = Number(env.SSE_EVENTS ?? 5)
			const intervalMs = Number(env.SSE_INTERVAL_MS ?? 1000)
			const encoder = new TextEncoder()
			const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
			const writer = writable.getWriter()
			void (async () => {
				for (let index = 0; index < events; index++) {
					await writer.write(encoder.encode(`event: data\ndata: {"n":${index},"t":${Date.now()}}\n\n`))
					if (index < events - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs))
				}
				await writer.close()
			})()
			return new Response(readable, {
				headers: { ...seen, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
			})
		}

		const headers = {
			...seen,
			'content-type': stream.contentType,
			'stream-next-offset': String(stream.chunks.length),
			'stream-up-to-date': 'true',
		}
		if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
		if (request.method === 'GET') return new Response(concat(stream.chunks), { status: 200, headers })
		return new Response(null, { status: 405, headers: seen })
	},
}
