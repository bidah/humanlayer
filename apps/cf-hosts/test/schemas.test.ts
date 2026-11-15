import { describe, expect, it } from 'vitest'

import { CreateHostRequest, RebootstrapRequest } from '../src/schemas'
import { HOST_ID, TOKEN } from './helpers'

describe('CreateHostRequest', () => {
	it('applies defaults: cloudflare provider, medium size, 24h ttl, empty env', () => {
		const r = CreateHostRequest.parse({ hostId: HOST_ID.toUpperCase(), daemonToken: TOKEN })
		expect(r).toMatchObject({ provider: 'cloudflare', size: 'medium', ttlMinutes: 1440, env: {}, labels: {} })
		expect(r.hostId).toBe(HOST_ID) // normalised to lower case
	})

	it('accepts the three providers and rejects others', () => {
		for (const provider of ['cloudflare', 'daytona', 'e2b']) {
			expect(CreateHostRequest.safeParse({ provider, hostId: HOST_ID, daemonToken: TOKEN }).success).toBe(true)
		}
		expect(CreateHostRequest.safeParse({ provider: 'modal', hostId: HOST_ID, daemonToken: TOKEN }).success).toBe(
			false,
		)
	})

	it('requires a UUID host id and a compact JWT', () => {
		expect(CreateHostRequest.safeParse({ hostId: 'not-a-uuid', daemonToken: TOKEN }).success).toBe(false)
		expect(CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: 'abc' }).success).toBe(false)
		expect(CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: 'a.b c.d' }).success).toBe(false)
	})

	it('rejects reserved and malformed env keys', () => {
		const bad = [
			{ RIPTIDE_DAEMON_TOKEN: 'x' },
			{ PATH: '/tmp' },
			{ HOME: '/' },
			{ LD_PRELOAD: 'x' },
			{ 'lower-case': 'x' },
			{ 'A;B': 'x' },
			{ OK: 'nul\0byte' },
		]
		for (const env of bad) {
			expect(
				CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: TOKEN, env }).success,
				JSON.stringify(env),
			).toBe(false)
		}
		const ok = CreateHostRequest.parse({
			hostId: HOST_ID,
			daemonToken: TOKEN,
			env: { ANTHROPIC_API_KEY: 'k', GH_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: "it's\nmultiline" },
		})
		expect(Object.keys(ok.env)).toHaveLength(3)
	})

	it('bounds ttl and size', () => {
		expect(CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: TOKEN, ttlMinutes: 5 }).success).toBe(false)
		expect(
			CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: TOKEN, ttlMinutes: 60 * 24 * 31 }).success,
		).toBe(false)
		expect(CreateHostRequest.safeParse({ hostId: HOST_ID, daemonToken: TOKEN, size: 'xl' }).success).toBe(false)
	})

	it('RebootstrapRequest requires a token', () => {
		expect(RebootstrapRequest.safeParse({ env: {} }).success).toBe(false)
		expect(RebootstrapRequest.safeParse({ daemonToken: TOKEN }).success).toBe(true)
	})
})
