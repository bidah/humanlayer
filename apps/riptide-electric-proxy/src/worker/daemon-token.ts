/**
 * Daemon token validation for the Worker build. Same contract as auth/daemon-tokens.ts, but the
 * public key comes from the Worker env and only the base64-PEM form is supported (the file-path
 * form in daemon-token-core.ts needs node:fs and has no meaning on workerd).
 */
import { importSPKI, jwtVerify } from 'jose'

import { type DaemonTokenClaims, parseDaemonTokenClaims } from '@/auth/daemon-token-core'

const ALG = 'RS256'

function decodeBase64Pem(value: string): string {
	const binary = atob(value.trim())
	return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

export function makeDaemonTokenValidator(base64PublicKeyPem: string | undefined) {
	// Cache the imported CryptoKey (a plain value, safe to share across requests), never the
	// in-flight import promise: a promise settled inside request A must not resume request B.
	let publicKey: CryptoKey | undefined

	return async (token: string): Promise<DaemonTokenClaims | null> => {
		if (!base64PublicKeyPem) return null
		try {
			publicKey ??= await importSPKI(decodeBase64Pem(base64PublicKeyPem), ALG)
			const { payload } = await jwtVerify(token, publicKey, { algorithms: [ALG] })
			return parseDaemonTokenClaims(payload)
		} catch {
			return null
		}
	}
}
