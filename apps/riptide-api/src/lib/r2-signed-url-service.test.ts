import { describe, expect, it } from 'vitest'

import { R2SignedUrlService, verifyObjectSignature } from './r2-signed-url-service'

const secret = 'test-secret'
const service = new R2SignedUrlService({
	bucket: { get: async () => null, put: async () => undefined },
	signingSecret: secret,
	publicOrigin: () => 'https://api.example.test/',
})

const claimsFrom = (url: URL, operation: 'put' | 'get') => ({
	operation,
	key: url.pathname.slice('/storage/v1/objects/'.length).split('/').map(decodeURIComponent).join('/'),
	contentType: url.searchParams.get('ct') ?? '',
	expiresAt: Number(url.searchParams.get('exp')),
})

describe('R2SignedUrlService', () => {
	it('mints upload URLs on this API whose signature covers key, content type and expiry', async () => {
		const url = new URL(await service.getPresignedUploadUrl('org/a b%/file.png', 'image/png', 15))
		expect(url.origin).toBe('https://api.example.test')
		expect(url.pathname).toBe('/storage/v1/objects/org/a%20b%25/file.png')
		expect(url.searchParams.get('op')).toBe('put')
		const claims = claimsFrom(url, 'put')
		const sig = url.searchParams.get('sig')!
		expect(claims.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(14 * 60)
		await expect(verifyObjectSignature(secret, claims, sig)).resolves.toBe(true)
		await expect(verifyObjectSignature(secret, { ...claims, contentType: 'text/html' }, sig)).resolves.toBe(false)
		await expect(verifyObjectSignature(secret, { ...claims, key: 'org/other' }, sig)).resolves.toBe(false)
		await expect(verifyObjectSignature(secret, { ...claims, operation: 'get' }, sig)).resolves.toBe(false)
		await expect(verifyObjectSignature('other-secret', claims, sig)).resolves.toBe(false)
	})

	it('mints download URLs defaulting to a 7 day expiry', async () => {
		const url = new URL(await service.getPresignedDownloadUrl('k'))
		const claims = claimsFrom(url, 'get')
		expect(claims.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(7 * 24 * 3600 - 5)
		await expect(verifyObjectSignature(secret, claims, url.searchParams.get('sig')!)).resolves.toBe(true)
	})
})
