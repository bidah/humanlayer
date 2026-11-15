import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'

import { exportPKCS8, generateKeyPair } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'

import { makeCloudHostTokenGate } from '../../src/auth/cloud-host-revocation'
import { getDaemonAuthContext } from '../../src/auth/context'
import { createSignedCloudHostDaemonToken, createSignedDaemonToken } from '../../src/auth/daemon-tokens'

const key = { organizationId: 'org-1', userId: 'user-1', hostId: 'host-1' }

describe('cloud host token gate', () => {
	test('accepts a live host, caches it briefly, and re-checks after the TTL', async () => {
		let now = 0
		let revokedAt: bigint | null = null
		let lookups = 0
		const gate = makeCloudHostTokenGate(
			async () => {
				lookups += 1
				return { revokedAt }
			},
			{ activeTtlMs: 10_000, now: () => now },
		)

		expect(await gate.isActive(key)).toBe(true)
		expect(await gate.isActive(key)).toBe(true)
		expect(lookups).toBe(1)

		revokedAt = 1n
		now = 9_999
		expect(await gate.isActive(key)).toBe(true)
		now = 10_001
		expect(await gate.isActive(key)).toBe(false)
		expect(lookups).toBe(2)

		// Revoked is permanent: never looked up again.
		now = 1_000_000
		expect(await gate.isActive(key)).toBe(false)
		expect(lookups).toBe(2)
	})

	test('rejects a token whose cloud host row does not exist', async () => {
		const gate = makeCloudHostTokenGate(async () => null)
		expect(await gate.isActive(key)).toBe(false)
	})

	test('markRevoked takes effect immediately in this isolate', async () => {
		const gate = makeCloudHostTokenGate(async () => ({ revokedAt: null }))
		expect(await gate.isActive(key)).toBe(true)
		gate.markRevoked(key)
		expect(await gate.isActive(key)).toBe(false)
	})

	test('a failed lookup propagates (the caller rejects) and is not cached', async () => {
		let fail = true
		const gate = makeCloudHostTokenGate(async () => {
			if (fail) throw new Error('database down')
			return { revokedAt: null }
		})
		await expect(gate.isActive(key)).rejects.toThrow('database down')
		fail = false
		expect(await gate.isActive(key)).toBe(true)
	})
})

describe('getDaemonAuthContext with cloud host tokens', () => {
	beforeAll(async () => {
		// Other suites in this worker may already have set (and cached) the private key; derive the
		// matching public key from whichever private key is in use.
		if (!process.env.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY) {
			const { privateKey } = await generateKeyPair('RS256', { extractable: true })
			process.env.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY = Buffer.from(await exportPKCS8(privateKey)).toString('base64')
		}
		const privatePem = Buffer.from(process.env.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY, 'base64').toString('utf8')
		const publicPem = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' })
		process.env.RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY = Buffer.from(String(publicPem)).toString('base64')
	})

	const request = (token: string) =>
		new Request('http://localhost/rpc/daemon/v1/hosts/heartbeat', { headers: { 'x-daemon-authorization': token } })

	test('ordinary daemon tokens never consult the gate', async () => {
		let consulted = 0
		const gate = { isActive: async () => (consulted++, false), markRevoked: () => {} }
		const hostId = randomUUID()
		const token = await createSignedDaemonToken('user-1', 'org-1', hostId)

		const context = await getDaemonAuthContext(request(token), gate)

		expect(context).toEqual({ userId: 'user-1', organizationId: 'org-1', hostId })
		expect(consulted).toBe(0)
	})

	test('a cloud host token is accepted while active and rejected once revoked', async () => {
		let active = true
		const gate = { isActive: async () => active, markRevoked: () => {} }
		const hostId = randomUUID()
		const token = await createSignedCloudHostDaemonToken('user-1', 'org-1', hostId)

		expect(await getDaemonAuthContext(request(token), gate)).toEqual({
			userId: 'user-1',
			organizationId: 'org-1',
			hostId,
			cloudHost: true,
		})
		active = false
		expect(await getDaemonAuthContext(request(token), gate)).toBeNull()
	})

	test('a gate failure rejects the cloud token (fails closed)', async () => {
		const gate = {
			isActive: async () => {
				throw new Error('database down')
			},
			markRevoked: () => {},
		}
		const token = await createSignedCloudHostDaemonToken('user-1', 'org-1', randomUUID())
		expect(await getDaemonAuthContext(request(token), gate)).toBeNull()
	})
})
