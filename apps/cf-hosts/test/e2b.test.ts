import { describe, expect, it } from 'vitest'

import { decodeEnvelopes, encodeEnvelope } from '../src/providers/connect'
import { E2BProvider } from '../src/providers/e2b'
import { ProviderError, type ProvisionInput } from '../src/providers/types'
import { ANTHROPIC_KEY, HOST_ID, mockFetch, type Recorded, TOKEN } from './helpers'

const SBX = 'i1abc2def3ghi4'
const ACCESS = 'envd-access-token-xyz'
const API_KEY = 'e2b_' + 'k'.repeat(40)

function b64(s: string) {
	return Buffer.from(s).toString('base64')
}

/** A Connect server-stream response: start, stdout chunk, end, end-of-stream trailer. */
function processStream(stdout: string, exitCode = 0) {
	const parts = [
		encodeEnvelope({ event: { start: { pid: 42 } } }),
		encodeEnvelope({ event: { data: { stdout: b64(stdout) } } }),
		encodeEnvelope({ event: { end: { exitCode, exited: true, status: `exit status ${exitCode}` } } }),
		encodeEnvelope({}, 0x02),
	]
	const total = parts.reduce((n, p) => n + p.length, 0)
	const buf = new Uint8Array(total)
	let off = 0
	for (const p of parts) {
		buf.set(p, off)
		off += p.length
	}
	return new Response(buf, { headers: { 'content-type': 'application/connect+json' } })
}

function scriptOf(r: Recorded): string {
	const env = decodeEnvelopes(r.body as Uint8Array)[0]!.json as { process: { cmd: string; args: string[] } }
	expect(env.process.cmd).toBe('/bin/bash')
	return env.process.args[2]!
}

function e2bWorld(opts: { existing?: boolean; status?: string } = {}) {
	let alive = Boolean(opts.existing)
	const listed = () =>
		alive
			? [
					{
						sandboxID: SBX,
						state: 'running',
						startedAt: 's',
						endAt: 'e',
						metadata: { app: 'humanlayer', hostId: HOST_ID },
					},
				]
			: []
	return mockFetch([
		[/api\.e2b\.app\/v2\/sandboxes\?/, 'GET', () => Response.json(listed())],
		[
			/api\.e2b\.app\/v2\/sandboxes$/,
			'POST',
			() => {
				alive = true
				return Response.json(
					{
						sandboxID: SBX,
						templateID: 'base',
						envdVersion: '0.5.0',
						envdAccessToken: ACCESS,
						domain: 'e2b.app',
					},
					{ status: 201 },
				)
			},
		],
		[
			new RegExp(`api\\.e2b\\.app/sandboxes/${SBX}$`),
			'GET',
			() =>
				alive
					? Response.json({
							sandboxID: SBX,
							state: 'running',
							envdAccessToken: ACCESS,
							domain: 'e2b.app',
							endAt: 'e',
							startedAt: 's',
						})
					: new Response('', { status: 404 }),
		],
		[
			new RegExp(`api\\.e2b\\.app/sandboxes/${SBX}$`),
			'DELETE',
			() => {
				const was = alive
				alive = false
				return new Response(null, { status: was ? 204 : 404 })
			},
		],
		[
			new RegExp(`49983-${SBX}\\.e2b\\.app/files\\?`),
			'POST',
			() => Response.json([{ name: 'f', path: '/p', type: 'file' }]),
		],
		[
			new RegExp(`49983-${SBX}\\.e2b\\.app/process\\.Process/Start`),
			'POST',
			(r) => {
				const script = scriptOf(r)
				if (script.includes('nohup setsid bash')) return processStream('started\n')
				if (script.includes('phase='))
					return processStream(opts.status ?? 'phase=running\nsupervisor=1\ndaemon=1\nerror=\n')
				if (script.includes('HLHOST:bootstrap')) {
					return processStream(
						`=====HLHOST:bootstrap=====\nclaude --version: 2.1.0 token ${TOKEN}\n=====HLHOST:daemon=====\nStarting daemon...\n`,
					)
				}
				return processStream('')
			},
		],
	])
}

const input: ProvisionInput = {
	hostId: HOST_ID,
	daemonToken: TOKEN,
	env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
	ttlMinutes: 60,
	size: 'medium',
	labels: { org: 'o1' },
	cli: { url: 'https://hosts.example.dev/cli/v1/humanlayer-linux-x64', sha256: 'c'.repeat(64), version: 'v1' },
}

describe('E2BProvider (mocked transport)', () => {
	it('creates a sandbox, uploads secrets as files, starts the bootstrap detached', async () => {
		const w = e2bWorld()
		const p = new E2BProvider({ apiKey: API_KEY, fetch: w.fetch })
		const r = await p.create(input)
		expect(r.created).toBe(true)
		expect(r.host).toMatchObject({
			provider: 'e2b',
			sandboxId: SBX,
			state: 'running',
			daemonRunning: true,
			bootstrapPhase: 'running',
		})

		const create = w.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/sandboxes'))!
		expect(create.headers['x-api-key']).toBe(API_KEY)
		expect(create.body).toMatchObject({
			templateID: 'base',
			timeout: 3600,
			allow_internet_access: true,
			metadata: { app: 'humanlayer', hostId: HOST_ID, org: 'o1' },
		})
		// Secrets are not passed as sandbox envVars (those are visible in the E2B API/dashboard).
		expect(JSON.stringify(create.body)).not.toContain(TOKEN)

		const uploads = w.calls.filter((c) => c.url.includes('/files?'))
		expect(uploads.map((u) => new URL(u.url).searchParams.get('path'))).toEqual([
			'/root/.hlhost-staging/host.env',
			'/root/.hlhost-staging/bootstrap.sh',
		])
		for (const u of uploads) {
			expect(new URL(u.url).searchParams.get('username')).toBe('root')
			expect(u.headers['x-access-token']).toBe(ACCESS)
		}
		const envFile = (uploads[0]!.body as { file: string }).file
		expect(envFile).toContain(`RIPTIDE_DAEMON_TOKEN='${TOKEN}'`)
		expect(envFile).toContain(`ANTHROPIC_API_KEY='${ANTHROPIC_KEY}'`)
		expect((uploads[1]!.body as { file: string }).file).toContain('HL_PROVIDER=e2b')

		const rpc = w.calls.filter((c) => c.url.includes('process.Process/Start'))
		for (const c of rpc) {
			expect(c.headers['content-type']).toBe('application/connect+json')
			expect(c.headers['connect-protocol-version']).toBe('1')
			expect(c.headers['authorization']).toBe(`Basic ${b64('root:')}`)
			expect(c.headers['x-access-token']).toBe(ACCESS)
		}
		expect(
			rpc.some((c) =>
				scriptOf(c).includes('nohup setsid bash /root/.hlhost-staging/bootstrap.sh /root/.hlhost-staging'),
			),
		).toBe(true)

		// No secret ever appears in a URL or a command line.
		for (const c of w.calls) {
			expect(c.url).not.toContain(TOKEN)
			expect(c.url).not.toContain(ANTHROPIC_KEY)
			if (c.url.includes('process.Process')) {
				expect(scriptOf(c)).not.toContain(TOKEN)
				expect(scriptOf(c)).not.toContain(ANTHROPIC_KEY)
			}
		}
	})

	it('is idempotent per hostId', async () => {
		const w = e2bWorld({ existing: true })
		const r = await new E2BProvider({ apiKey: API_KEY, fetch: w.fetch }).create(input)
		expect(r.created).toBe(false)
		expect(w.calls.some((c) => c.method === 'POST' && c.url.endsWith('/v2/sandboxes'))).toBe(false)
		const list = w.calls.find((c) => c.url.includes('/v2/sandboxes?'))!
		const q = new URL(list.url).searchParams
		expect(q.get('metadata')).toBe(`hostId=${HOST_ID}`)
		expect(q.getAll('state')).toEqual(['running', 'paused'])
	})

	it('reports bootstrap failures and redacts logs', async () => {
		const w = e2bWorld({
			existing: true,
			status: 'phase=failed\nsupervisor=0\ndaemon=0\nerror=Claude Code install failed\n',
		})
		const p = new E2BProvider({ apiKey: API_KEY, fetch: w.fetch })
		expect(await p.status(HOST_ID)).toMatchObject({ state: 'failed', error: 'Claude Code install failed' })
		const logs = await p.logs(HOST_ID, 50)
		expect(logs.bootstrap).toContain('claude --version: 2.1.0')
		expect(logs.bootstrap).not.toContain(TOKEN)
		expect(logs.daemon).toContain('Starting daemon')
	})

	it('destroys and then reports not_found', async () => {
		const w = e2bWorld({ existing: true })
		const p = new E2BProvider({ apiKey: API_KEY, fetch: w.fetch })
		expect(await p.destroy(HOST_ID)).toEqual({ destroyed: true })
		expect((await p.status(HOST_ID)).state).toBe('not_found')
		expect(await p.destroy(HOST_ID)).toEqual({ destroyed: false })
	})

	it('lists only humanlayer sandboxes', async () => {
		const w = e2bWorld({ existing: true })
		const hosts = await new E2BProvider({ apiKey: API_KEY, fetch: w.fetch }).list()
		expect(hosts).toEqual([
			{
				provider: 'e2b',
				hostId: HOST_ID,
				sandboxId: SBX,
				providerState: 'running',
				createdAt: 's',
				expiresAt: 'e',
			},
		])
		expect(new URL(w.calls[0]!.url).searchParams.get('metadata')).toBe('app=humanlayer')
	})

	it('rejects ttl beyond the E2B 24h cap before calling the API', async () => {
		const w = e2bWorld()
		await expect(
			new E2BProvider({ apiKey: API_KEY, fetch: w.fetch }).create({ ...input, ttlMinutes: 1500 }),
		).rejects.toThrowError(ProviderError)
		expect(w.calls).toHaveLength(0)
	})

	it('deletes the sandbox if the bootstrap cannot be started', async () => {
		const base = e2bWorld()
		let deleted = false
		const f: typeof base.fetch = async (i, init) => {
			const url = String(i instanceof Request ? i.url : i)
			if (url.includes('/files?')) return new Response('disk full', { status: 507 })
			if (url.endsWith(`/sandboxes/${SBX}`) && init?.method === 'DELETE') deleted = true
			return base.fetch(i, init)
		}
		await expect(new E2BProvider({ apiKey: API_KEY, fetch: f }).create(input)).rejects.toThrow(/upload/)
		expect(deleted).toBe(true)
	})

	it('surfaces Connect end-of-stream errors', async () => {
		const f = mockFetch([
			[
				/v2\/sandboxes\?/,
				'GET',
				() =>
					Response.json([
						{ sandboxID: SBX, state: 'running', metadata: { app: 'humanlayer', hostId: HOST_ID } },
					]),
			],
			[
				new RegExp(`sandboxes/${SBX}$`),
				'GET',
				() => Response.json({ sandboxID: SBX, state: 'running', envdAccessToken: ACCESS }),
			],
			[
				/process\.Process\/Start/,
				'POST',
				() => new Response(encodeEnvelope({ error: { code: 'unavailable', message: 'envd down' } }, 0x02)),
			],
		])
		await expect(new E2BProvider({ apiKey: API_KEY, fetch: f.fetch }).status(HOST_ID)).rejects.toThrow(/envd down/)
	})
})
