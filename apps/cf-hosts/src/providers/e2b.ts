/**
 * E2B provider over plain fetch. UNVERIFIED against the live service (no E2B key exists); written
 * against e2b@2.63.0's wire calls and covered by mocked-transport tests.
 *
 * The `e2b` SDK is not used at runtime: it imports undici, glob, tar and chalk, which are a poor
 * fit for workerd. Wire calls mirrored from e2b@2.63.0 (dist/index.mjs):
 *   POST   {api}/v2/sandboxes                       {templateID, metadata, envVars, timeout, allow_internet_access}
 *   GET    {api}/sandboxes/{id}                     detail (state, endAt, envdAccessToken, domain)
 *   GET    {api}/v2/sandboxes?metadata=<urlencoded k=v>&state=running&state=paused
 *   DELETE {api}/sandboxes/{id}
 *   envd   https://49983-{id}.{domain}/process.Process/Start  (Connect, server-streaming, JSON codec)
 *   envd   https://49983-{id}.{domain}/files?path=..&username=root  multipart "file"
 * Auth: `X-API-KEY` for the API; `X-Access-Token: <envdAccessToken>` for envd; the Linux user is
 * selected with `Authorization: Basic base64("<user>:")`.
 *
 * Lifetime: E2B kills a sandbox at its `timeout` regardless of activity, so ttlMinutes maps to
 * `timeout` directly (E2B caps it at 1h on Hobby and 24h on Pro).
 */
import { base64ToString, stringToBase64 } from '../base64'
import {
	buildHostEnv,
	logsCommand,
	parseLogsOutput,
	parseStatusOutput,
	renderBootstrapScript,
	renderEnvFile,
	STATUS_COMMAND,
	stateFromStatus,
} from '../bootstrap'
import { redact } from '../redact'
import type { HostInfo, HostLogs, HostState } from '../schemas'
import { ConnectError, connectServerStream } from './connect'
import {
	type CliArtifact,
	type CloudHostProvider,
	type CreateResult,
	emptyHostInfo,
	type FetchLike,
	type HostSummary,
	ProviderError,
	type ProvisionInput,
	type RebootstrapInput,
} from './types'

export const E2B_ENVD_PORT = 49983
export const E2B_STAGING = '/root/.hlhost-staging'
/** E2B caps sandbox timeout at 24h on Pro. */
export const E2B_MAX_TTL_MINUTES = 24 * 60

interface E2BCreated {
	sandboxID: string
	templateID?: string
	envdVersion?: string
	envdAccessToken?: string
	domain?: string | null
}

interface E2BDetail extends E2BCreated {
	state?: string
	startedAt?: string
	endAt?: string
	metadata?: Record<string, string>
	cpuCount?: number
	memoryMB?: number
}

interface E2BListed {
	sandboxID: string
	state?: string
	startedAt?: string
	endAt?: string
	metadata?: Record<string, string>
}

export interface E2BConfig {
	apiKey: string
	apiUrl?: string
	domain?: string
	/** Template to boot. `base` is small (about 512 MiB RAM); use a custom template with >= 4 GiB. */
	template?: string
	fetch?: FetchLike
}

function mapState(s: string | undefined): HostState {
	if (s === 'running') return 'bootstrapping'
	if (s === 'paused') return 'stopped'
	return 'provisioning'
}

export class E2BProvider implements CloudHostProvider {
	readonly name = 'e2b' as const
	private readonly f: FetchLike
	private readonly apiUrl: string
	private readonly domain: string

	constructor(private readonly cfg: E2BConfig) {
		this.f = cfg.fetch ?? ((i, init) => fetch(i, init))
		this.apiUrl = (cfg.apiUrl ?? 'https://api.e2b.app').replace(/\/+$/, '')
		this.domain = cfg.domain ?? 'e2b.app'
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
		const headers = new Headers({ 'X-API-KEY': this.cfg.apiKey })
		if (body !== undefined) headers.set('content-type', 'application/json')
		const res = await this.f(`${this.apiUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		if (res.status === 404) return { status: 404, data: null }
		if (!res.ok)
			throw new ProviderError(
				'provider_error',
				`e2b ${method} ${path} -> ${res.status}: ${redact(text).slice(0, 500)}`,
			)
		return { status: res.status, data: text ? (JSON.parse(text) as T) : null }
	}

	private envdUrl(sb: E2BCreated): string {
		return `https://${E2B_ENVD_PORT}-${sb.sandboxID}.${sb.domain || this.domain}`
	}

	private envdHeaders(sb: E2BCreated, user = 'root'): Headers {
		const h = new Headers({
			Authorization: `Basic ${stringToBase64(`${user}:`)}`,
			'E2b-Sandbox-Id': sb.sandboxID,
			'E2b-Sandbox-Port': String(E2B_ENVD_PORT),
		})
		if (sb.envdAccessToken) h.set('X-Access-Token', sb.envdAccessToken)
		return h
	}

	/** Run `bash -l -c <script>` as root via envd and collect its output. */
	async exec(sb: E2BCreated, script: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
		let messages: unknown[]
		const headers = this.envdHeaders(sb)
		headers.set('Keepalive-Ping-Interval', '50')
		try {
			messages = await connectServerStream(
				this.f,
				`${this.envdUrl(sb)}/process.Process/Start`,
				{ process: { cmd: '/bin/bash', args: ['-l', '-c', script], envs: {} }, stdin: false },
				headers,
				timeoutMs,
			)
		} catch (e) {
			if (e instanceof ConnectError) throw new ProviderError('provider_error', `e2b envd: ${redact(e.message)}`)
			throw e
		}
		let output = ''
		let exitCode = -1
		for (const m of messages) {
			const ev = (m as { event?: Record<string, Record<string, unknown>> }).event
			if (!ev) continue
			if (ev.data) {
				const chunk = (ev.data.stdout ?? ev.data.stderr) as string | undefined
				if (chunk) output += base64ToString(chunk)
			}
			if (ev.end) exitCode = typeof ev.end.exitCode === 'number' ? ev.end.exitCode : 0
		}
		return { exitCode, output }
	}

	private async upload(sb: E2BCreated, path: string, content: string): Promise<void> {
		const form = new FormData()
		form.append('file', new Blob([content], { type: 'application/octet-stream' }), path)
		const q = new URLSearchParams({ path, username: 'root' })
		const res = await this.f(`${this.envdUrl(sb)}/files?${q.toString()}`, {
			method: 'POST',
			headers: this.envdHeaders(sb),
			body: form,
		})
		if (!res.ok)
			throw new ProviderError(
				'provider_error',
				`e2b upload ${path} -> ${res.status}: ${redact(await res.text()).slice(0, 300)}`,
			)
	}

	private async findListed(hostId: string): Promise<E2BListed | null> {
		const metadata = new URLSearchParams({ hostId }).toString()
		const q = new URLSearchParams({ metadata })
		q.append('state', 'running')
		q.append('state', 'paused')
		const { data } = await this.api<E2BListed[]>('GET', `/v2/sandboxes?${q.toString()}`)
		return (data ?? []).find((s) => s.metadata?.app === 'humanlayer' && s.metadata?.hostId === hostId) ?? null
	}

	private async detail(id: string): Promise<E2BDetail | null> {
		const { data } = await this.api<E2BDetail>('GET', `/sandboxes/${encodeURIComponent(id)}`)
		return data
	}

	private async find(hostId: string): Promise<E2BDetail | null> {
		const listed = await this.findListed(hostId)
		if (!listed) return null
		const d = await this.detail(listed.sandboxID)
		return d ? { ...listed, ...d } : null
	}

	private async startBootstrap(
		sb: E2BCreated,
		hostId: string,
		daemonToken: string,
		env: Record<string, string>,
		cli: CliArtifact,
	) {
		const script = renderBootstrapScript({
			hostId,
			provider: 'e2b',
			cliUrl: cli.url,
			cliSha256: cli.sha256,
			cliVersion: cli.version,
		})
		const envFile = renderEnvFile(buildHostEnv({ hostId, provider: 'e2b', daemonToken, env }))
		await this.exec(sb, `umask 077; mkdir -p ${E2B_STAGING}; chmod 700 ${E2B_STAGING}`)
		await this.upload(sb, `${E2B_STAGING}/host.env`, envFile)
		await this.upload(sb, `${E2B_STAGING}/bootstrap.sh`, script)
		const r = await this.exec(
			sb,
			`chmod 600 ${E2B_STAGING}/host.env; chmod 700 ${E2B_STAGING}/bootstrap.sh; ` +
				`nohup setsid bash ${E2B_STAGING}/bootstrap.sh ${E2B_STAGING} >/dev/null 2>&1 </dev/null & echo started`,
		)
		if (!r.output.includes('started'))
			throw new ProviderError('provider_error', `e2b: bootstrap did not start: ${redact(r.output)}`)
	}

	async create(input: ProvisionInput): Promise<CreateResult> {
		if (input.ttlMinutes > E2B_MAX_TTL_MINUTES) {
			throw new ProviderError('invalid_request', `e2b sandboxes live at most ${E2B_MAX_TTL_MINUTES} minutes`)
		}
		const existing = await this.findListed(input.hostId)
		if (existing) return { host: await this.status(input.hostId), created: false }
		const t0 = Date.now()
		const { data } = await this.api<E2BCreated>('POST', '/v2/sandboxes', {
			templateID: this.cfg.template ?? 'base',
			metadata: { ...input.labels, app: 'humanlayer', hostId: input.hostId, managedBy: 'humanlayer-hosts' },
			timeout: input.ttlMinutes * 60,
			allow_internet_access: true,
		})
		if (!data?.sandboxID) throw new ProviderError('provider_error', 'e2b create returned no sandboxID')
		const startedMs = Date.now() - t0
		try {
			await this.startBootstrap(data, input.hostId, input.daemonToken, input.env, input.cli)
		} catch (e) {
			// Do not leave a paid sandbox behind when the bootstrap could not even be started.
			await this.api('DELETE', `/sandboxes/${encodeURIComponent(data.sandboxID)}`).catch(() => undefined)
			throw e
		}
		const host = await this.status(input.hostId)
		return { host, created: true, timings: { sandboxStartMs: startedMs, totalMs: Date.now() - t0 } }
	}

	async rebootstrap(input: RebootstrapInput): Promise<HostInfo> {
		const sb = await this.find(input.hostId)
		if (!sb) throw new ProviderError('not_found', `no e2b host ${input.hostId}`)
		if (sb.state !== 'running') throw new ProviderError('provider_error', `e2b sandbox is ${sb.state}, not running`)
		await this.startBootstrap(sb, input.hostId, input.daemonToken, input.env, input.cli)
		return this.status(input.hostId)
	}

	async status(hostId: string): Promise<HostInfo> {
		const sb = await this.find(hostId)
		if (!sb) return emptyHostInfo('e2b', hostId)
		const info: HostInfo = {
			...emptyHostInfo('e2b', hostId),
			sandboxId: sb.sandboxID,
			state: mapState(sb.state),
			providerState: sb.state ?? null,
			createdAt: sb.startedAt ?? null,
			expiresAt: sb.endAt ?? null,
		}
		if (sb.state !== 'running') return info
		const { output } = await this.exec(sb, STATUS_COMMAND, 20_000)
		const s = parseStatusOutput(output)
		return {
			...info,
			state: stateFromStatus(s),
			bootstrapPhase: s.phase,
			supervisorRunning: s.supervisorRunning,
			daemonRunning: s.daemonRunning,
			error: s.error ? redact(s.error) : null,
		}
	}

	async logs(hostId: string, lines: number): Promise<HostLogs> {
		const sb = await this.find(hostId)
		if (!sb) throw new ProviderError('not_found', `no e2b host ${hostId}`)
		if (sb.state !== 'running') return { provider: 'e2b', hostId, bootstrap: '', daemon: '' }
		const { output } = await this.exec(sb, logsCommand(lines), 30_000)
		return { provider: 'e2b', hostId, ...parseLogsOutput(redact(output)) }
	}

	async destroy(hostId: string): Promise<{ destroyed: boolean }> {
		const sb = await this.findListed(hostId)
		if (!sb) return { destroyed: false }
		const { status } = await this.api('DELETE', `/sandboxes/${encodeURIComponent(sb.sandboxID)}`)
		return { destroyed: status !== 404 }
	}

	async list(): Promise<HostSummary[]> {
		const q = new URLSearchParams({ metadata: new URLSearchParams({ app: 'humanlayer' }).toString() })
		q.append('state', 'running')
		q.append('state', 'paused')
		const { data } = await this.api<E2BListed[]>('GET', `/v2/sandboxes?${q.toString()}`)
		const out: HostSummary[] = []
		for (const s of data ?? []) {
			const hostId = s.metadata?.hostId
			if (!hostId || s.metadata?.app !== 'humanlayer') continue
			out.push({
				provider: 'e2b',
				hostId,
				sandboxId: s.sandboxID,
				providerState: s.state ?? null,
				createdAt: s.startedAt ?? null,
				expiresAt: s.endAt ?? null,
			})
		}
		return out
	}
}
