import type { Hono } from 'hono'

import { requireEnvironment } from '../lib/environment'
import {
	R2_MAX_OBJECT_BYTES,
	R2_OBJECT_ROUTE_PREFIX,
	type SignedObjectClaims,
	verifyObjectSignature,
} from '../lib/r2-signed-url-service'
import type { R2BucketBinding } from '../platform/worker-env'

/**
 * Serves the HMAC-signed object URLs minted by `R2SignedUrlService` (Cloudflare deployment):
 * `PUT /storage/v1/objects/<key>?op=put&ct=..&exp=..&sig=..` streams the body into R2, and
 * `GET` with `op=get` streams it back. Mirrors S3 presigned-URL semantics: the URL
 * alone authorises the operation until it expires, and an upload must send the signed
 * content type.
 */
export function registerR2ObjectStorageRoutes(
	app: Hono,
	deps: { readonly getBucket: () => R2BucketBinding | undefined },
) {
	const route = `${R2_OBJECT_ROUTE_PREFIX}:key{.+}`

	// The key is taken from the raw (still percent-encoded) path, not Hono's decoded param, so a
	// key containing `%` round-trips exactly as R2SignedUrlService encoded it.
	const authorize = async (
		url: URL,
		operation: SignedObjectClaims['operation'],
	): Promise<{ claims: SignedObjectClaims } | { error: string; status: 400 | 403 }> => {
		let key: string
		try {
			key = url.pathname.slice(R2_OBJECT_ROUTE_PREFIX.length).split('/').map(decodeURIComponent).join('/')
		} catch {
			return { error: 'Malformed object key', status: 400 }
		}
		if (key.length === 0) return { error: 'Missing object key', status: 400 }
		const signature = url.searchParams.get('sig')
		const expiresAt = Number(url.searchParams.get('exp'))
		if (url.searchParams.get('op') !== operation || !signature || !Number.isInteger(expiresAt)) {
			return { error: 'Missing or invalid signature parameters', status: 403 }
		}
		if (expiresAt < Math.floor(Date.now() / 1000)) return { error: 'Signed URL expired', status: 403 }
		const claims: SignedObjectClaims = {
			operation,
			key,
			contentType: url.searchParams.get('ct') ?? '',
			expiresAt,
		}
		const valid = await verifyObjectSignature(requireEnvironment('ARTIFACT_URL_SIGNING_SECRET'), claims, signature)
		return valid ? { claims } : { error: 'Invalid signature', status: 403 }
	}

	app.put(route, async (c) => {
		const bucket = deps.getBucket()
		if (!bucket) return c.json({ error: 'Object storage is not configured' }, 503)
		const auth = await authorize(new URL(c.req.url), 'put')
		if ('error' in auth) return c.json({ error: auth.error }, auth.status)

		const contentType = c.req.header('content-type') ?? ''
		if (auth.claims.contentType && contentType !== auth.claims.contentType) {
			return c.json({ error: 'Content-Type does not match the signed upload URL' }, 403)
		}
		const lengthHeader = c.req.header('content-length')
		const length = lengthHeader === undefined ? Number.NaN : Number(lengthHeader)
		if (!Number.isFinite(length)) return c.json({ error: 'Content-Length is required' }, 411)
		if (length > R2_MAX_OBJECT_BYTES) {
			return c.json({ error: 'Object too large', maxBytes: R2_MAX_OBJECT_BYTES }, 413)
		}

		await bucket.put(auth.claims.key, c.req.raw.body, {
			httpMetadata: { contentType: auth.claims.contentType || contentType || 'application/octet-stream' },
		})
		return c.body(null, 200)
	})

	// Hono answers HEAD from the GET route (body dropped).
	app.get(route, async (c) => {
		const bucket = deps.getBucket()
		if (!bucket) return c.json({ error: 'Object storage is not configured' }, 503)
		const auth = await authorize(new URL(c.req.url), 'get')
		if ('error' in auth) return c.json({ error: auth.error }, auth.status)
		const object = await bucket.get(auth.claims.key)
		if (!object) return c.json({ error: 'Not found' }, 404)
		const headers = new Headers({
			'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
			'content-length': String(object.size),
			etag: object.httpEtag,
			'cache-control': 'private, max-age=300',
		})
		return new Response(object.body, { status: 200, headers })
	})
}
