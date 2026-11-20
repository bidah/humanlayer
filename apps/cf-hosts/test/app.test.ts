import { describe, expect, it, vi } from 'vitest'

import { createApp } from '../src/app'
import { isAuthorized, timingSafeEqualStrings } from '../src/auth'
import type { Env } from '../src/env'
import { selectProvider } from '../src/providers'
import type { CloudflareDeps, HostSandboxStub } from '../src/providers/cloudflare'
import { emptyHostInfo, ProviderError } from '../src/providers/types'
import { redact } from '../src/redact'
import { ANTHROPIC_KEY, fakeBucket, HOST_ID, MANIFEST, SECRET, TOKEN } from './helpers'

function fakeCloudflare() {
	const created = new Map<string, unknown>()
	const stub = (hostId: string): HostSandboxStub => ({
		hlCreate: vi.fn(async (p) => {
			const existed = created.has(hostId)
			created.set(hostId, p)
			return {
				created: !existed,
				host: { ...emptyHostInfo('cloudflare', hostId), state: 'bootstrapping' as const, sandboxId: hostId },
				timings: { containerReadyMs: 1, totalMs: 2 },
			}
		}),
		hlRebootstrap: vi.fn(async () => (created.has(hostId) ? emptyHostInfo('cloudflare', hostId) : null)),
		hlStatus: vi.fn(async () =>
			created.has(hostId)
				? {
						...emptyHostInfo('cloudflare', hostId),
						state: 'running' as const,
						sandboxId: hostId,
						daemonRunning: true,
					}
				: emptyHostInfo('cloudflare', ''),
		),
		hlLogs: vi.fn(async () =>
			created.has(hostId) ? { provider: 'cloudflare' as const, hostId, bootstrap: 'b', daemon: 'd' } : null,
		),
		hlDestroy: vi.fn(async () => ({ destroyed: created.delete(hostId) })),
		hlMeta: vi.fn(async () => null),
	})
	const stubs = new Map<string, HostSandboxStub>()
	const deps: CloudflareDeps = {
		sandbox: (id) => {
			if (!stubs.has(id)) stubs.set(id, stub(id))
			return stubs.get(id)!
		},
		registry: () => ({
			list: async () => [...created.keys()].map((hostId) => ({ hostId, createdAt: 'c', expiresAt: 'e' })),
		}),
	}
	return { deps, created, stubs }
}

const baseEnv = { INTERNAL_SERVICE_SECRET: SECRET } as unknown as Env

function setup(env: Partial<Env> = {}) {
	const cf = fakeCloudflare()
	const app = createApp({ deps: { cloudflare: cf.deps }, bucket: fakeBucket() })
	const req = (method: string, path: string, body?: unknown, auth: string | null = `Bearer ${SECRET}`) =>
		app.request(
			`https://human-flare-hosts.test${path}`,
			{
				method,
				headers: {
					...(auth ? { authorization: auth } : {}),
					...(body ? { 'content-type': 'application/json' } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			},
			{ ...baseEnv, ...env } as Env,
		)
	return { app, req, cf }
}

describe('auth', () => {
	it('compares in constant time and requires a configured secret', async () => {
		expect(await timingSafeEqualStrings('abc', 'abc')).toBe(true)
		expect(await timingSafeEqualStrings('abc', 'abd')).toBe(false)
		expect(await timingSafeEqualStrings('abc', 'abcd')).toBe(false)
		expect(await isAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true)
		expect(await isAuthorized(`bearer ${SECRET}`, SECRET)).toBe(true)
		expect(await isAuthorized(`Basic ${SECRET}`, SECRET)).toBe(false)
		expect(await isAuthorized(undefined, SECRET)).toBe(false)
		expect(await isAuthorized(`Bearer ${SECRET}`, undefined)).toBe(false)
		expect(await isAuthorized('Bearer short', 'short')).toBe(false) // secrets < 16 chars are refused
	})

	it('protects every /v1 route', async () => {
		const { req } = setup()
		for (const [m, p] of [
			['GET', '/v1/hosts'],
			['POST', '/v1/hosts'],
			['GET', `/v1/hosts/cloudflare/${HOST_ID}`],
			['GET', `/v1/hosts/cloudflare/${HOST_ID}/logs`],
			['POST', `/v1/hosts/cloudflare/${HOST_ID}/bootstrap`],
			['DELETE', `/v1/hosts/cloudflare/${HOST_ID}`],
		] as const) {
			expect((await req(m, p, undefined, null)).status, `${m} ${p}`).toBe(401)
			expect((await req(m, p, undefined, 'Bearer wrong-secret-wrong-secret')).status).toBe(401)
		}
	})

	it('leaves /health and /cli public', async () => {
		const { req } = setup()
		expect((await req('GET', '/health', undefined, null)).status).toBe(200)
		const bin = await req('GET', '/cli/latest/humanlayer-linux-x64', undefined, null)
		expect(bin.status).toBe(200)
		expect(bin.headers.get('x-checksum-sha256')).toBe(MANIFEST.sha256)
		expect(await bin.text()).toBe('ELF!')
		expect((await req('GET', '/cli/abc123def456/humanlayer-linux-x64', undefined, null)).status).toBe(200)
		expect((await req('GET', '/cli/nope/humanlayer-linux-x64', undefined, null)).status).toBe(404)
		expect((await req('GET', '/cli/latest/etc-passwd', undefined, null)).status).toBe(404)
		expect((await req('GET', '/cli/..%2F..%2Fsecret/manifest.json', undefined, null)).status).toBe(404)
		const latest = await req('GET', '/cli/latest.json', undefined, null)
		expect(await latest.json()).toMatchObject({ version: MANIFEST.version })
	})

	it('serves the other platforms a manifest lists, and 404s the ones it does not', async () => {
		const darwin = { key: 'cli/v2/humanlayer-darwin-arm64', sha256: 'b'.repeat(64), size: 6 }
		const manifest = { ...MANIFEST, version: 'v2', files: { 'humanlayer-darwin-arm64': darwin } }
		const bucket = fakeBucket({
			'cli/latest.json': manifest,
			'cli/v2/manifest.json': manifest,
			'cli/v2/humanlayer-darwin-arm64': 'MACHO!',
		})
		const app = createApp({ deps: { cloudflare: fakeCloudflare().deps }, bucket })
		const req = (method: string, path: string, _body?: unknown, _auth?: null) =>
			app.request(`https://human-flare-hosts.test${path}`, { method }, { INTERNAL_SERVICE_SECRET: SECRET } as Env)
		const bin = await req('GET', '/cli/latest/humanlayer-darwin-arm64', undefined, null)
		expect(bin.status).toBe(200)
		expect(bin.headers.get('x-checksum-sha256')).toBe(darwin.sha256)
		expect(await bin.text()).toBe('MACHO!')
		expect((await req('GET', '/cli/v2/humanlayer-darwin-arm64', undefined, null)).status).toBe(200)
		expect((await req('GET', '/cli/latest/humanlayer-linux-arm64', undefined, null)).status).toBe(404)
		expect((await req('GET', '/cli/latest/humanlayer-solaris-sparc', undefined, null)).status).toBe(404)
	})
})

describe('provider selection', () => {
	it('defaults to cloudflare and routes per request', async () => {
		const { req, cf } = setup()
		const res = await req('POST', '/v1/hosts', {
			hostId: HOST_ID,
			daemonToken: TOKEN,
			env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
		})
		expect(res.status).toBe(201)
		const body = (await res.json()) as { created: boolean; host: { provider: string; sandboxId: string } }
		expect(body).toMatchObject({ created: true, host: { provider: 'cloudflare', sandboxId: HOST_ID } })
		const call = (cf.stubs.get(HOST_ID)!.hlCreate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
		expect(call).toMatchObject({
			hostId: HOST_ID,
			daemonToken: TOKEN,
			ttlMinutes: 1440,
			cli: {
				url: `https://human-flare-hosts.test/cli/${MANIFEST.version}/humanlayer-linux-x64`,
				sha256: MANIFEST.sha256,
			},
		})
		// Idempotent: a second create for the same host returns 200 created=false.
		const again = await req('POST', '/v1/hosts', { hostId: HOST_ID, daemonToken: TOKEN })
		expect(again.status).toBe(200)
		expect(((await again.json()) as { created: boolean }).created).toBe(false)
	})

	it('returns 501 provider-not-configured for daytona/e2b without keys', async () => {
		const { req } = setup()
		for (const provider of ['daytona', 'e2b']) {
			const res = await req('POST', '/v1/hosts', { provider, hostId: HOST_ID, daemonToken: TOKEN })
			expect(res.status).toBe(501)
			const body = (await res.json()) as { error: { code: string; message: string } }
			expect(body.error.code).toBe('not_configured')
			expect(body.error.message).toContain(provider === 'e2b' ? 'E2B_API_KEY' : 'DAYTONA_API_KEY')
		}
		expect(() => selectProvider('e2b', {})).toThrowError(ProviderError)
		expect(selectProvider('e2b', { E2B_API_KEY: 'e2b_x' }).name).toBe('e2b')
		expect(selectProvider('daytona', { DAYTONA_API_KEY: 'k' }).name).toBe('daytona')
	})

	it('validates bodies and path params with zod (400)', async () => {
		const { req } = setup()
		const bad = await req('POST', '/v1/hosts', { hostId: 'x', daemonToken: TOKEN })
		expect(bad.status).toBe(400)
		expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_request')
		expect(
			(await req('POST', '/v1/hosts', { hostId: HOST_ID, daemonToken: TOKEN, env: { PATH: '/x' } })).status,
		).toBe(400)
		expect((await req('GET', '/v1/hosts/modal/' + HOST_ID)).status).toBe(400)
		expect((await req('GET', '/v1/hosts/cloudflare/not-a-uuid')).status).toBe(400)
		expect((await req('GET', `/v1/hosts/cloudflare/${HOST_ID}/logs?lines=99999`)).status).toBe(400)
		const notJson = await app_request_raw()
		expect(notJson).toBe(400)
	})

	it('status / logs / list / destroy round trip', async () => {
		const { req } = setup()
		expect((await req('GET', `/v1/hosts/cloudflare/${HOST_ID}`)).status).toBe(404)
		await req('POST', '/v1/hosts', { hostId: HOST_ID, daemonToken: TOKEN })
		const st = await req('GET', `/v1/hosts/cloudflare/${HOST_ID}`)
		expect(st.status).toBe(200)
		expect(((await st.json()) as { host: { state: string } }).host.state).toBe('running')
		expect(await (await req('GET', `/v1/hosts/cloudflare/${HOST_ID}/logs?lines=10`)).json()).toMatchObject({
			daemon: 'd',
		})
		const list = (await (await req('GET', '/v1/hosts')).json()) as { hosts: Array<{ hostId: string }> }
		expect(list.hosts.map((h) => h.hostId)).toEqual([HOST_ID])
		expect((await req('POST', `/v1/hosts/cloudflare/${HOST_ID}/bootstrap`, { daemonToken: TOKEN })).status).toBe(
			200,
		)
		expect((await req('DELETE', `/v1/hosts/cloudflare/${HOST_ID}`)).status).toBe(200)
		expect((await req('DELETE', `/v1/hosts/cloudflare/${HOST_ID}`)).status).toBe(404)
		expect((await req('POST', `/v1/hosts/cloudflare/${HOST_ID}/bootstrap`, { daemonToken: TOKEN })).status).toBe(
			404,
		)
	})
})

async function app_request_raw() {
	const { app } = setup()
	const res = await app.request(
		'https://human-flare-hosts.test/v1/hosts',
		{
			method: 'POST',
			headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
			body: '{not json',
		},
		baseEnv,
	)
	return res.status
}

describe('redact', () => {
	it('scrubs tokens and keys', () => {
		const s = redact(`token=${TOKEN} key=${ANTHROPIC_KEY} gh=ghp_${'a'.repeat(36)} Authorization: Bearer abc.def`)
		expect(s).not.toContain(TOKEN)
		expect(s).not.toContain(ANTHROPIC_KEY)
		expect(s).not.toContain('ghp_')
		expect(s).toContain('Authorization: Bearer [REDACTED]')
	})
})
