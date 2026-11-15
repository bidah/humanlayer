// Generates the service's secrets into .env.cloudflare if they are not there yet:
//   HUMANLAYER_AUTH_API_KEY          -> Worker secret API_KEY; also WORKOS_API_KEY for riptide-api / the proxy
//   HUMANLAYER_AUTH_SIGNING_KEY_JWK  -> Worker secret SIGNING_KEY_JWK (RS256 private JWK with kid)
//   HUMANLAYER_AUTH_WEBHOOK_SECRET   -> Worker secret WEBHOOK_SECRET; also WORKOS_WEBHOOK_SECRET for riptide-api
// Prints key names only.
import { appendEnv, readEnvFile } from './env-file'

const existing = readEnvFile()
const random = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

async function signingJwk(): Promise<string> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
	return JSON.stringify({
		...jwk,
		alg: 'RS256',
		kid: `hl_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${random(4)}`,
	})
}

const wanted: Array<[string, () => Promise<string> | string]> = [
	['HUMANLAYER_AUTH_API_KEY', () => `sk_hl_${random(32)}`],
	['HUMANLAYER_AUTH_SIGNING_KEY_JWK', signingJwk],
	['HUMANLAYER_AUTH_WEBHOOK_SECRET', () => random(32)],
]

for (const [key, make] of wanted) {
	if (existing.has(key)) {
		console.log(`${key}: already present, left unchanged`)
		continue
	}
	appendEnv(key, await make())
	console.log(`${key}: generated and appended`)
}
