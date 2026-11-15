import type { ArtifactBucket, CliManifest } from '../src/cli-artifacts'
import type { FetchLike } from '../src/providers/types'

export const HOST_ID = '3f0f6c1e-8a51-4c8e-9b7a-1d2e3f4a5b6c'
export const SECRET = 'internal-secret-for-tests-0123456789'
// Shape-valid compact JWT; content is irrelevant to this service.
export const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VySWQiOiJ1MSIsImhvc3RJZCI6ImgxIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ'
export const ANTHROPIC_KEY = 'sk-ant-api03-supersecretvalue-abcdefghijklmnop'

export const MANIFEST: CliManifest = {
	version: 'abc123def456',
	gitSha: 'abc123def456',
	dirty: false,
	cliVersion: '0.40.0',
	platform: 'linux-x64',
	key: 'cli/abc123def456/humanlayer-linux-x64',
	sha256: 'a'.repeat(64),
	size: 4,
	origins: {},
	builtAt: '2026-11-14T00:00:00Z',
}

export function fakeBucket(
	objects: Record<string, string | object> = {
		'cli/latest.json': MANIFEST,
		'cli/abc123def456/manifest.json': MANIFEST,
		'cli/abc123def456/humanlayer-linux-x64': 'ELF!',
	},
): ArtifactBucket {
	const get = async (key: string) => {
		const v = objects[key]
		if (v === undefined) return null
		const text = typeof v === 'string' ? v : JSON.stringify(v)
		return {
			body: new Response(text).body!,
			size: text.length,
			httpEtag: '"etag"',
			json: async <T>() => JSON.parse(text) as T,
		}
	}
	return {
		get,
		head: async (key) => (objects[key] === undefined ? null : { size: 4, httpEtag: '"etag"' }),
	}
}

export interface Recorded {
	method: string
	url: string
	headers: Record<string, string>
	body: unknown
}

/** A routing fake fetch that records every request (body decoded where possible). */
export function mockFetch(routes: Array<[RegExp, string, (r: Recorded) => Response | Promise<Response>]>) {
	const calls: Recorded[] = []
	const f: FetchLike = async (input, init) => {
		const req = new Request(input as string, init)
		const headers: Record<string, string> = {}
		req.headers.forEach((v, k) => (headers[k] = v))
		let body: unknown = null
		const ct = headers['content-type'] ?? ''
		if (init?.body instanceof FormData) {
			const fd = init.body
			const file = fd.get('file') as Blob | null
			body = { file: file ? await file.text() : null }
		} else if (init?.body instanceof Uint8Array) {
			body = init.body
		} else if (ct.includes('json') && init?.body) {
			body = JSON.parse(String(init.body))
		}
		const rec: Recorded = { method: req.method, url: req.url, headers, body }
		calls.push(rec)
		for (const [re, method, handler] of routes) {
			if (re.test(req.url) && method === req.method) return handler(rec)
		}
		return new Response(`no route for ${req.method} ${req.url}`, { status: 599 })
	}
	return { fetch: f, calls }
}
