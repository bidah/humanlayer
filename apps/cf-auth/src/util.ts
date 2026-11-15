const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID (time-ordered, 26 chars Crockford base32), as WorkOS ids use after their prefix. */
export function ulid(now = Date.now()): string {
	let time = now
	let timePart = ''
	for (let i = 0; i < 10; i++) {
		timePart = CROCKFORD.charAt(time % 32) + timePart
		time = Math.floor(time / 32)
	}
	const random = crypto.getRandomValues(new Uint8Array(16))
	let randomPart = ''
	for (const byte of random) randomPart += CROCKFORD.charAt(byte % 32)
	return timePart + randomPart
}

export const newId = (prefix: string) => `${prefix}_${ulid()}`

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	let binary = ''
	for (const b of view) binary += String.fromCharCode(b)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlDecode(input: string): Uint8Array<ArrayBuffer> {
	const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4)
	const binary = atob(base64)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(input: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)))
}

export async function sha256b64(input: string): Promise<string> {
	return base64url(await sha256(input))
}

/** Constant-time comparison of two byte arrays (lengths are compared first; equal-length inputs are expected). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false
	const subtle = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean
	}
	if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(a, b)
	let diff = 0
	for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
	return diff === 0
}

/** Constant-time string comparison: hashes both sides so length differences don't leak through timing. */
export async function secretEqual(a: string, b: string): Promise<boolean> {
	const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
	return bytesEqual(ha, hb)
}

export const nowIso = () => new Date().toISOString()

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
	})
}

/** WorkOS-shaped error. 401/404/409/422/429 map to the SDK's typed exceptions; others to GenericServerException. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: Record<string, unknown>,
	) {
		super(
			typeof body.message === 'string'
				? body.message
				: typeof body.error_description === 'string'
					? body.error_description
					: `HTTP ${status}`,
		)
	}
}

export const notFound = (what: string) => new ApiError(404, { code: 'entity_not_found', message: `${what} not found.` })
export const unprocessable = (message: string, field?: string) =>
	new ApiError(422, {
		code: 'invalid_request_parameters',
		message,
		errors: field ? [{ field, code: `${field}_invalid` }] : [],
	})
export const badRequest = (code: string, message: string) => new ApiError(400, { code, message })
export const oauthError = (status: number, error: string, description: string) =>
	new ApiError(status, { error, error_description: description })

export function parseCookies(header: string | null): Map<string, string> {
	const out = new Map<string, string>()
	if (!header) return out
	for (const part of header.split(';')) {
		const idx = part.indexOf('=')
		if (idx < 0) continue
		out.set(part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim()))
	}
	return out
}

export function cookie(
	name: string,
	value: string,
	opts: { secure: boolean; maxAge: number; sameSite: 'Lax' | 'Strict' },
): string {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		'Path=/',
		'HttpOnly',
		`SameSite=${opts.sameSite}`,
		`Max-Age=${opts.maxAge}`,
	]
	if (opts.secure) parts.push('Secure')
	return parts.join('; ')
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
