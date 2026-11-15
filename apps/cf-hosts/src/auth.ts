/** Constant-time comparison of two strings via SHA-256 digests (lengths never leak through timing). */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder()
	const [da, db] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b)),
	])
	const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean }
	if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(da, db) && a.length === b.length
	// Fallback (Node test runtime): constant-time XOR over the fixed-length digests.
	const x = new Uint8Array(da)
	const y = new Uint8Array(db)
	let diff = 0
	for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
	return diff === 0
}

/** Validates `Authorization: Bearer <secret>`. Returns false when the secret is not configured. */
export async function isAuthorized(header: string | null | undefined, secret: string | undefined): Promise<boolean> {
	if (!secret || secret.length < 16) return false
	if (!header) return false
	const presented = header.match(/^Bearer\s+(.+)$/i)?.[1]
	if (!presented) return false
	return timingSafeEqualStrings(presented.trim(), secret)
}
