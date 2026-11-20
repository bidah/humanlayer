import type { R2BucketBinding } from '../platform/worker-env'
import type { IS3Service } from './s3-service'

/**
 * Object storage for the Cloudflare deployment: an R2 bucket binding plus time-limited,
 * HMAC-signed URLs that point back at this Worker (`/storage/v1/objects/<key>`), which streams
 * the PUT/GET to R2 (see `routes/r2-object-storage.ts`). It stands in for S3 presigned URLs, which
 * browsers and daemons use directly, when there are no S3 credentials.
 */

export const R2_OBJECT_ROUTE_PREFIX = '/storage/v1/objects/'

/** Upper bound for a single object PUT, matching the API's largest upload limit (50 MB). */
export const R2_MAX_OBJECT_BYTES = 50 * 1024 * 1024

export type SignedObjectOperation = 'put' | 'get'

export interface SignedObjectClaims {
	readonly operation: SignedObjectOperation
	readonly key: string
	/** Content type the uploader must send (put only; empty for get). */
	readonly contentType: string
	/** Unix seconds. */
	readonly expiresAt: number
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: ArrayBuffer): string => {
	let binary = ''
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const canonical = (claims: SignedObjectClaims): string =>
	['hl-r2-v1', claims.operation, claims.key, claims.contentType, String(claims.expiresAt)].join('\n')

const importKey = (secret: string, usage: 'sign' | 'verify') =>
	crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

export async function signObjectClaims(secret: string, claims: SignedObjectClaims): Promise<string> {
	const key = await importKey(secret, 'sign')
	return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical(claims))))
}

export async function verifyObjectSignature(
	secret: string,
	claims: SignedObjectClaims,
	signature: string,
): Promise<boolean> {
	// Recompute and compare in constant time.
	const expected = await signObjectClaims(secret, claims)
	if (expected.length !== signature.length) return false
	let diff = 0
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
	return diff === 0
}

/** Encode each key segment but keep `/` so keys map onto readable paths. */
export const encodeObjectKeyPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/')

export class R2SignedUrlService implements IS3Service {
	constructor(
		private readonly options: {
			readonly bucket: R2BucketBinding
			readonly signingSecret: string
			/** Public origin of this API, e.g. https://human-flare-api.example.workers.dev */
			readonly publicOrigin: () => string
		},
	) {}

	private async buildUrl(claims: SignedObjectClaims): Promise<string> {
		const signature = await signObjectClaims(this.options.signingSecret, claims)
		const url = new URL(
			`${R2_OBJECT_ROUTE_PREFIX}${encodeObjectKeyPath(claims.key)}`,
			this.options.publicOrigin().replace(/\/+$/, '') + '/',
		)
		url.searchParams.set('op', claims.operation)
		if (claims.contentType) url.searchParams.set('ct', claims.contentType)
		url.searchParams.set('exp', String(claims.expiresAt))
		url.searchParams.set('sig', signature)
		return url.toString()
	}

	async getPresignedUploadUrl(key: string, contentType: string, expiresInMinutes = 15): Promise<string> {
		return this.buildUrl({
			operation: 'put',
			key,
			contentType,
			expiresAt: Math.floor(Date.now() / 1000) + Math.ceil(expiresInMinutes * 60),
		})
	}

	async getPresignedDownloadUrl(key: string, expiresInMinutes = 10080): Promise<string> {
		return this.buildUrl({
			operation: 'get',
			key,
			contentType: '',
			expiresAt: Math.floor(Date.now() / 1000) + Math.ceil(expiresInMinutes * 60),
		})
	}

	/** Server-side write (no URL round trip): a Worker cannot reliably fetch its own hostname. */
	async putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
		await this.options.bucket.put(key, bytes, { httpMetadata: { contentType } })
	}
}
