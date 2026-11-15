import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'

import type { AppConfig } from '../src/app-config'
import { makeCloudHostTokenGate } from '../src/auth/cloud-host-revocation'
import type { DaemonTokenClaims } from '../src/auth/daemon-token-core'
import { createAuthMiddleware } from '../src/middleware'

const claims = (overrides: Partial<DaemonTokenClaims> = {}): DaemonTokenClaims => ({
	userId: 'user-1',
	organizationId: 'org-1',
	hostId: 'host-1',
	createdAt: 1,
	...overrides,
})

function appWith(validated: DaemonTokenClaims | null, gate: { isActive: () => Promise<boolean> }) {
	const config = {
		electricShapeUrl: 'http://electric.test/v1/shape',
		durableStreamsOrigin: 'http://streams.test',
		effectRuntime: {} as AppConfig['effectRuntime'],
		db: {} as AppConfig['db'],
		validateDaemonToken: async () => validated,
		cloudHostTokenGate: gate,
	} satisfies AppConfig
	const app = new Hono()
	app.use('*', createAuthMiddleware(config))
	app.get('/', (c) => c.json(c.get('authContext' as never)))
	return app
}

const daemonRequest = () => new Request('http://proxy.test/', { headers: { 'x-daemon-authorization': 'token' } })

describe('sync proxy daemon auth with cloud host tokens', () => {
	test('ordinary daemon tokens are accepted without a revocation lookup', async () => {
		let consulted = 0
		const response = await appWith(claims(), { isActive: async () => (consulted++, false) }).fetch(daemonRequest())
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ organizationId: 'org-1', userId: 'user-1', hostId: 'host-1' })
		expect(consulted).toBe(0)
	})

	test('a live cloud host token is accepted', async () => {
		const response = await appWith(claims({ cloudHost: true }), { isActive: async () => true }).fetch(
			daemonRequest(),
		)
		expect(response.status).toBe(200)
	})

	test('a revoked cloud host token is rejected with 401', async () => {
		const response = await appWith(claims({ cloudHost: true }), { isActive: async () => false }).fetch(
			daemonRequest(),
		)
		expect(response.status).toBe(401)
	})

	test('a failing revocation lookup rejects the cloud host token', async () => {
		const response = await appWith(claims({ cloudHost: true }), {
			isActive: async () => {
				throw new Error('database down')
			},
		}).fetch(daemonRequest())
		expect(response.status).toBe(401)
	})
})

describe('cloud host token gate (proxy)', () => {
	test('caches active for the TTL, revoked forever, and rejects unknown hosts', async () => {
		let now = 0
		let row: { revokedAt: bigint | null } | null = { revokedAt: null }
		let lookups = 0
		const gate = makeCloudHostTokenGate(
			async () => {
				lookups += 1
				return row
			},
			{ activeTtlMs: 1_000, now: () => now },
		)
		const key = { organizationId: 'o', userId: 'u', hostId: 'h' }

		expect(await gate.isActive(key)).toBe(true)
		row = { revokedAt: 5n }
		expect(await gate.isActive(key)).toBe(true)
		now = 1_001
		expect(await gate.isActive(key)).toBe(false)
		now = 10_000_000
		expect(await gate.isActive(key)).toBe(false)
		expect(lookups).toBe(2)

		row = null
		expect(await gate.isActive({ ...key, hostId: 'unknown' })).toBe(false)
	})
})
