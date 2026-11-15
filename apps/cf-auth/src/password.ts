import { base64url, base64urlDecode, bytesEqual } from './util'

// PBKDF2-HMAC-SHA256 via WebCrypto. 100,000 iterations is the maximum the Workers runtime
// accepts for PBKDF2 (higher counts throw NotSupportedError). The iteration count is stored in
// each hash, so it can be raised (and hashes upgraded on sign-in) if the runtime limit changes.
export const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
	const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
		'deriveBits',
	])
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		material,
		KEY_BITS,
	)
	return new Uint8Array(bits)
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
	const hash = await derive(password, salt, iterations)
	return `pbkdf2-sha256$${iterations}$${base64url(salt)}$${base64url(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, iterationsRaw, saltB64, hashB64] = stored.split('$')
	if (scheme !== 'pbkdf2-sha256' || !iterationsRaw || !saltB64 || !hashB64) return false
	const iterations = Number.parseInt(iterationsRaw, 10)
	if (!Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false
	const expected = base64urlDecode(hashB64)
	const actual = await derive(password, base64urlDecode(saltB64), iterations)
	return bytesEqual(actual, expected)
}

// Verified against when the email is unknown, so a miss costs the same as a wrong password.
const DUMMY_HASH = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
export async function burnPasswordCheck(password: string): Promise<void> {
	await verifyPassword(password, DUMMY_HASH)
}

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 256
