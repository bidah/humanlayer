import { describe, expect, it } from 'vitest'

import { DaytonaProvider, daytonaSandboxName } from '../src/providers/daytona'
import type { ProvisionInput } from '../src/providers/types'
import { ANTHROPIC_KEY, HOST_ID, mockFetch, TOKEN } from './helpers'

const SB_ID = '11111111-2222-3333-4444-555555555555'
const API = 'https://app.daytona.io/api'

function decodeCommand(body: unknown): string {
	const cmd = (body as { command: string }).command
	const m = cmd.match(/^bash -c "echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash"$/)
	expect(m).not.toBeNull()
	return Buffer.from(m![1]!, 'base64').toString('utf8')
}

function world(initial: string | null) {
	let state = initial
	const sandbox = () => ({
		id: SB_ID,
		name: daytonaSandboxName(HOST_ID),
		state,
		toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox',
		labels: { app: 'humanlayer', hostId: HOST_ID },
		cpu: 2,
		memory: 4,
		// Daytona returns raw newlines inside the echoed Dockerfile.
		buildInfo: { dockerfileContent: 'FROM daytonaio/sandbox:0.11.0\n' },
	})
	const raw = (o: unknown) => new Response(JSON.stringify(o).replace('\\n', '\n'))
	return mockFetch([
		[
			/\/sandbox\/humanlayer-host-/,
			'GET',
			() => (state ? raw(sandbox()) : new Response('{"message":"not found"}', { status: 404 })),
		],
		[
			/\/api\/sandbox$/,
			'POST',
			() => {
				state = 'started'
				return raw(sandbox())
			},
		],
		[
			new RegExp(`/api/sandbox/${SB_ID}$`),
			'DELETE',
			() => {
				state = null
				return new Response('', { status: 200 })
			},
		],
		[/\/files\/upload-v2\?/, 'POST', () => new Response('')],
		[
			/\/process\/execute$/,
			'POST',
			(r) => {
				const script = decodeCommand(r.body)
				if (script.includes('nohup setsid')) return Response.json({ exitCode: 0, result: 'started\n' })
				if (script.includes('phase='))
					return Response.json({ exitCode: 0, result: 'phase=claude\nsupervisor=0\ndaemon=0\nerror=\n' })
				return Response.json({ exitCode: 0, result: '' })
			},
		],
	])
}

const input: ProvisionInput = {
	hostId: HOST_ID,
	daemonToken: TOKEN,
	env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY },
	ttlMinutes: 120,
	size: 'large',
	labels: {},
	cli: { url: 'https://hosts.example.dev/cli/v1/humanlayer-linux-x64', sha256: null, version: 'v1' },
}

describe('DaytonaProvider (mocked transport)', () => {
	it('creates with resources via buildInfo, ttl, no auto-stop, and bootstraps via file upload', async () => {
		const w = world(null)
		const p = new DaytonaProvider({ apiKey: 'dtn_key', apiUrl: API, fetch: w.fetch, sleep: async () => {} })
		const r = await p.create(input)
		expect(r.created).toBe(true)
		expect(r.host).toMatchObject({
			provider: 'daytona',
			sandboxId: SB_ID,
			state: 'bootstrapping',
			bootstrapPhase: 'claude',
		})
		const create = w.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/sandbox'))!
		expect(create.headers.authorization).toBe('Bearer dtn_key')
		expect(create.body).toMatchObject({
			name: `humanlayer-host-${HOST_ID}`,
			labels: { app: 'humanlayer', hostId: HOST_ID },
			cpu: 4,
			memory: 8,
			autoStopInterval: 0,
			ttlMinutes: 120,
			buildInfo: { dockerfileContent: 'FROM daytonaio/sandbox:0.11.0\n' },
		})
		expect(JSON.stringify(create.body)).not.toContain(TOKEN)
		const uploads = w.calls.filter((c) => c.url.includes('upload-v2'))
		expect(uploads.map((u) => new URL(u.url).searchParams.get('path'))).toEqual([
			'/tmp/.hlhost-staging/host.env',
			'/tmp/.hlhost-staging/bootstrap.sh',
		])
		expect((uploads[0]!.body as { file: string }).file).toContain(`RIPTIDE_DAEMON_TOKEN='${TOKEN}'`)
		for (const c of w.calls) {
			expect(c.url).not.toContain(TOKEN)
			if (c.url.endsWith('/process/execute')) expect(decodeCommand(c.body)).not.toContain(TOKEN)
		}
	})

	it('ignores same-named sandboxes not labelled as ours', async () => {
		const f = mockFetch([
			[
				/\/sandbox\/humanlayer-host-/,
				'GET',
				() => Response.json({ id: SB_ID, state: 'started', labels: { app: 'other' } }),
			],
		])
		const p = new DaytonaProvider({ apiKey: 'k', apiUrl: API, fetch: f.fetch })
		expect((await p.status(HOST_ID)).state).toBe('not_found')
		expect(await p.destroy(HOST_ID)).toEqual({ destroyed: false })
	})

	it('destroys by id', async () => {
		const w = world('started')
		const p = new DaytonaProvider({ apiKey: 'k', apiUrl: API, fetch: w.fetch })
		expect(await p.destroy(HOST_ID)).toEqual({ destroyed: true })
		expect((await p.status(HOST_ID)).state).toBe('not_found')
	})
})
