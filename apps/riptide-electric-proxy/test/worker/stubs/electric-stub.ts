/**
 * Local stand-in for the `human-flare-electric` Worker, used only by `wrangler dev` smoke tests of
 * the human-flare-sync Worker (see test/worker/smoke.ts). It echoes what the proxy sent so the
 * smoke test can assert on the server-chosen table/where/params and on the Electric secret
 * (reported as a SHA-256 digest, never echoed in clear).
 *
 * `live=true` requests are held for LIVE_HOLD_MS (default 20 s) to mimic an Electric long-poll.
 */
type Env = { LIVE_HOLD_MS?: string }

async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/v1/health') return Response.json({ status: 'active' })
		if (url.pathname !== '/v1/shape') return new Response('not found', { status: 404 })

		const startedAt = Date.now()
		const live = url.searchParams.get('live') === 'true'
		if (live) await new Promise((resolve) => setTimeout(resolve, Number(env.LIVE_HOLD_MS ?? 20_000)))

		const params: Record<string, string> = {}
		for (const [key, value] of url.searchParams) if (key.startsWith('params[')) params[key] = value
		const secret = url.searchParams.get('secret')

		return Response.json(
			{
				stub: 'electric',
				method: request.method,
				path: url.pathname,
				table: url.searchParams.get('table'),
				where: url.searchParams.get('where'),
				params,
				offset: url.searchParams.get('offset'),
				live,
				heldMs: Date.now() - startedAt,
				secretSha256: secret === null ? null : await sha256Hex(secret),
				body: request.method === 'POST' ? await request.text() : undefined,
			},
			{
				headers: {
					'electric-handle': 'stub-handle',
					'electric-offset': '0_0',
					'electric-schema': '{}',
					...(live ? { 'electric-up-to-date': '' } : {}),
				},
			},
		)
	},
}
