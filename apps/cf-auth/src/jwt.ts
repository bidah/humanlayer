import type { Env } from './env'
import { base64url } from './util'

/** Claim layout of a WorkOS AuthKit access token (see packages/schemas/src/effect/workos-access-token.ts). */
export interface AccessTokenClaims {
	iss: string
	sub: string
	sid: string
	jti: string
	org_id?: string
	role?: string
	roles?: string[]
	permissions?: string[]
	entitlements?: string[]
	feature_flags?: string[]
	internal_org_id?: string
	iat?: number
	exp?: number
}

type SigningKey = { kid: string; key: CryptoKey }

let cachedSource: string | undefined
let cachedKey: Promise<SigningKey> | undefined

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const

function parseJwk(raw: string, name: string): JsonWebKey & { kid: string } {
	const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string }
	const kid = jwk.kid
	if (jwk.kty !== 'RSA' || !kid) throw new Error(`${name} must be an RSA JWK with a kid`)
	return { ...jwk, kid }
}

function signingKey(env: Env): Promise<SigningKey> {
	if (cachedKey && cachedSource === env.SIGNING_KEY_JWK) return cachedKey
	cachedSource = env.SIGNING_KEY_JWK
	cachedKey = (async () => {
		const jwk = parseJwk(env.SIGNING_KEY_JWK, 'SIGNING_KEY_JWK')
		if (!jwk.d) throw new Error('SIGNING_KEY_JWK must be a private key')
		const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256' }, RS256, false, ['sign'])
		return { kid: jwk.kid, key }
	})()
	return cachedKey
}

function publicPart(jwk: JsonWebKey & { kid?: string }) {
	return { kty: 'RSA', alg: 'RS256', use: 'sig', kid: jwk.kid, n: jwk.n, e: jwk.e }
}

/** JWKS document in the shape WorkOS serves at /sso/jwks/:clientId. */
export function jwks(env: Env) {
	const keys = [publicPart(parseJwk(env.SIGNING_KEY_JWK, 'SIGNING_KEY_JWK'))]
	if (env.SIGNING_KEY_JWK_PREVIOUS)
		keys.push(publicPart(parseJwk(env.SIGNING_KEY_JWK_PREVIOUS, 'SIGNING_KEY_JWK_PREVIOUS')))
	return { keys }
}

export async function signJwt(env: Env, payload: AccessTokenClaims): Promise<string> {
	const { kid, key } = await signingKey(env)
	const enc = new TextEncoder()
	const header = base64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })))
	const body = base64url(enc.encode(JSON.stringify(payload)))
	const signature = await crypto.subtle.sign(RS256, key, enc.encode(`${header}.${body}`))
	return `${header}.${body}.${base64url(signature)}`
}
