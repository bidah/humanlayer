import { stringToBase64 } from '../base64'
/**
 * Daytona provider over the REST API with fetch (the @daytonaio/sdk pulls in axios, ws, OTel and
 * the AWS SDK, which do not belong in a Worker). Endpoints mirror @daytona/api-client and
 * @daytona/toolbox-api-client 0.230:
 *   POST/GET/DELETE {api}/sandbox[/{idOrName}]       lifecycle
 *   POST {toolboxProxyUrl}/{id}/process/execute      run a command  {command, timeout}
 *   POST {toolboxProxyUrl}/{id}/files/upload-v2?path multipart "file"
 *
 * Mapping: sandbox name `humanlayer-host-<hostId>`, labels {app: humanlayer, hostId}. Resources can
 * only be set together with a declarative image (`buildInfo`), which Daytona builds on its side and
 * caches; `ttlMinutes` makes Daytona destroy the sandbox on expiry; `autoStopInterval: 0` disables
 * idle auto-stop (the daemon makes only outbound connections, which Daytona does not count).
 */
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
import type { HostInfo, HostLogs, HostSize, HostState } from '../schemas'
import {
	type CloudHostProvider,
	type CreateResult,
	emptyHostInfo,
	type FetchLike,
	ProviderError,
	type ProvisionInput,
	type RebootstrapInput,
	type HostSummary,
	type CliArtifact,
} from './types'

export const DAYTONA_BASE_IMAGE = 'daytonaio/sandbox:0.11.0'
export const DAYTONA_STAGING = '/tmp/.hlhost-staging'

export const DAYTONA_SIZES: Record<HostSize, { cpu: number; memory: number; disk: number }> = {
	small: { cpu: 1, memory: 2, disk: 10 },
	medium: { cpu: 2, memory: 4, disk: 10 },
	large: { cpu: 4, memory: 8, disk: 10 },
}

export function daytonaSandboxName(hostId: string): string {
	return `humanlayer-host-${hostId}`
}

interface DaytonaSandbox {
	id: string
	name: string
	state: string
	errorReason?: string | null
	toolboxProxyUrl?: string
	labels?: Record<string, string>
	cpu?: number
	memory?: number
	createdAt?: string
	autoDestroyAt?: string | null
}

/** Daytona echoes the Dockerfile with raw newlines inside JSON strings; make it parseable. */
function parseLooseJson<T>(text: string): T {
	// oxlint-disable-next-line no-control-regex
	return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' ')) as T
}

function mapState(s: string | undefined): HostState {
	switch (s) {
		case 'started':
			return 'bootstrapping' // refined by the in-sandbox status probe
		case 'creating':
		case 'restoring':
		case 'starting':
		case 'pending_build':
		case 'building_snapshot':
		case 'pulling_snapshot':
		case 'resizing':
		case 'unknown':
			return 'provisioning'
		case 'stopped':
		case 'stopping':
		case 'archived':
		case 'archiving':
		case 'paused':
			return 'stopped'
		case 'destroying':
			return 'destroying'
		case 'destroyed':
			return 'not_found'
		case 'error':
		case 'build_failed':
			return 'failed'
		default:
			return 'provisioning'
	}
}

export interface DaytonaConfig {
	apiKey: string
	apiUrl: string
	fetch?: FetchLike
	/** Max time create() waits for the sandbox to reach `started`. */
	startTimeoutMs?: number
	pollIntervalMs?: number
	sleep?: (ms: number) => Promise<void>
}

export class DaytonaProvider implements CloudHostProvider {
	readonly name = 'daytona' as const
	private readonly f: FetchLike
	private readonly apiUrl: string

	constructor(private readonly cfg: DaytonaConfig) {
		this.f = cfg.fetch ?? ((i, init) => fetch(i, init))
		this.apiUrl = cfg.apiUrl.replace(/\/+$/, '')
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		return { Authorization: `Bearer ${this.cfg.apiKey}`, 'X-Daytona-Source': 'human-flare-hosts', ...extra }
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
		const res = await this.f(`${this.apiUrl}${path}`, {
			method,
			headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		if (res.status === 404) return { status: 404, data: null }
		if (!res.ok) {
			throw new ProviderError(
				'provider_error',
				`daytona ${method} ${path} -> ${res.status}: ${redact(text).slice(0, 500)}`,
			)
		}
		return { status: res.status, data: text ? parseLooseJson<T>(text) : null }
	}

	private async find(hostId: string): Promise<DaytonaSandbox | null> {
		const { data } = await this.api<DaytonaSandbox>(
			'GET',
			`/sandbox/${encodeURIComponent(daytonaSandboxName(hostId))}`,
		)
		if (!data || data.state === 'destroyed') return null
		// Never act on a sandbox this service did not create.
		if (data.labels?.app !== 'humanlayer' || data.labels?.hostId !== hostId) return null
		return data
	}

	private toolboxBase(sb: DaytonaSandbox): string {
		const proxy = (sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox').replace(/\/+$/, '')
		return `${proxy}/${sb.id}`
	}

	/** Run a shell snippet. The script is base64-wrapped so no quoting survives into the toolbox. */
	async exec(sb: DaytonaSandbox, script: string, timeoutSec = 60): Promise<{ exitCode: number; output: string }> {
		const b64 = stringToBase64(script)
		const res = await this.f(`${this.toolboxBase(sb)}/process/execute`, {
			method: 'POST',
			headers: this.headers({ 'content-type': 'application/json' }),
			body: JSON.stringify({ command: `bash -c "echo ${b64} | base64 -d | bash"`, timeout: timeoutSec }),
		})
		const text = await res.text()
		if (!res.ok)
			throw new ProviderError('provider_error', `daytona exec -> ${res.status}: ${redact(text).slice(0, 300)}`)
		const data = parseLooseJson<{ exitCode?: number; result?: string }>(text)
		return { exitCode: data.exitCode ?? 0, output: data.result ?? '' }
	}

	private async upload(sb: DaytonaSandbox, path: string, content: string): Promise<void> {
		const form = new FormData()
		form.append('file', new Blob([content], { type: 'application/octet-stream' }), path.split('/').pop())
		const res = await this.f(`${this.toolboxBase(sb)}/files/upload-v2?path=${encodeURIComponent(path)}`, {
			method: 'POST',
			headers: this.headers(),
			body: form,
		})
		if (!res.ok) {
			throw new ProviderError(
				'provider_error',
				`daytona upload ${path} -> ${res.status}: ${redact(await res.text()).slice(0, 300)}`,
			)
		}
	}

	private async startBootstrap(
		sb: DaytonaSandbox,
		hostId: string,
		daemonToken: string,
		env: Record<string, string>,
		cli: CliArtifact,
	) {
		const script = renderBootstrapScript({
			hostId,
			provider: 'daytona',
			cliUrl: cli.url,
			cliSha256: cli.sha256,
			cliVersion: cli.version,
		})
		const envFile = renderEnvFile(buildHostEnv({ hostId, provider: 'daytona', daemonToken, env }))
		await this.exec(sb, `umask 077; mkdir -p ${DAYTONA_STAGING}; chmod 700 ${DAYTONA_STAGING}`)
		await this.upload(sb, `${DAYTONA_STAGING}/host.env`, envFile)
		await this.upload(sb, `${DAYTONA_STAGING}/bootstrap.sh`, script)
		const r = await this.exec(
			sb,
			`chmod 600 ${DAYTONA_STAGING}/host.env; chmod 700 ${DAYTONA_STAGING}/bootstrap.sh; ` +
				`nohup setsid bash ${DAYTONA_STAGING}/bootstrap.sh ${DAYTONA_STAGING} >/dev/null 2>&1 </dev/null & echo started`,
		)
		if (!r.output.includes('started'))
			throw new ProviderError('provider_error', `daytona: bootstrap did not start: ${redact(r.output)}`)
	}

	private async waitStarted(name: string): Promise<DaytonaSandbox> {
		const deadline = Date.now() + (this.cfg.startTimeoutMs ?? 180_000)
		const sleep = this.cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
		for (;;) {
			const { data } = await this.api<DaytonaSandbox>('GET', `/sandbox/${encodeURIComponent(name)}`)
			if (data?.state === 'started') return data
			if (data && (data.state === 'error' || data.state === 'build_failed')) {
				throw new ProviderError(
					'provider_error',
					`daytona sandbox ${data.state}: ${data.errorReason ?? 'unknown'}`,
				)
			}
			if (Date.now() > deadline)
				throw new ProviderError('timeout', `daytona sandbox not started (state=${data?.state})`)
			await sleep(this.cfg.pollIntervalMs ?? 2000)
		}
	}

	async create(input: ProvisionInput): Promise<CreateResult> {
		const existing = await this.find(input.hostId)
		if (existing) return { host: await this.status(input.hostId), created: false }
		const t0 = Date.now()
		const res = DAYTONA_SIZES[input.size]
		const name = daytonaSandboxName(input.hostId)
		const labels = {
			...input.labels,
			app: 'humanlayer',
			hostId: input.hostId,
			managedBy: 'human-flare-hosts',
			cliVersion: input.cli.version ?? 'unknown',
		}
		await this.api('POST', '/sandbox', {
			name,
			labels,
			public: false,
			cpu: res.cpu,
			memory: res.memory,
			disk: res.disk,
			autoStopInterval: 0,
			autoArchiveInterval: 0,
			ttlMinutes: input.ttlMinutes,
			buildInfo: { dockerfileContent: `FROM ${DAYTONA_BASE_IMAGE}\n`, contextHashes: [] },
		})
		const sb = await this.waitStarted(name)
		const startedMs = Date.now() - t0
		await this.startBootstrap(sb, input.hostId, input.daemonToken, input.env, input.cli)
		const host = await this.status(input.hostId)
		return { host, created: true, timings: { sandboxStartMs: startedMs, totalMs: Date.now() - t0 } }
	}

	async rebootstrap(input: RebootstrapInput): Promise<HostInfo> {
		const sb = await this.find(input.hostId)
		if (!sb) throw new ProviderError('not_found', `no daytona host ${input.hostId}`)
		if (sb.state !== 'started')
			throw new ProviderError('provider_error', `daytona sandbox is ${sb.state}, not started`)
		await this.startBootstrap(sb, input.hostId, input.daemonToken, input.env, input.cli)
		return this.status(input.hostId)
	}

	private baseInfo(hostId: string, sb: DaytonaSandbox): HostInfo {
		const size = (Object.entries(DAYTONA_SIZES).find(([, v]) => v.cpu === sb.cpu && v.memory === sb.memory)?.[0] ??
			null) as HostSize | null
		return {
			...emptyHostInfo('daytona', hostId),
			sandboxId: sb.id,
			state: mapState(sb.state),
			providerState: sb.state,
			error: sb.errorReason ?? null,
			createdAt: sb.createdAt ?? null,
			expiresAt: sb.autoDestroyAt ?? null,
			size,
			cliVersion: sb.labels?.cliVersion ?? null,
		}
	}

	async status(hostId: string): Promise<HostInfo> {
		const sb = await this.find(hostId)
		if (!sb) return emptyHostInfo('daytona', hostId)
		const info = this.baseInfo(hostId, sb)
		if (sb.state !== 'started') return info
		const { output } = await this.exec(sb, STATUS_COMMAND, 20)
		const s = parseStatusOutput(output)
		return {
			...info,
			state: stateFromStatus(s),
			bootstrapPhase: s.phase,
			supervisorRunning: s.supervisorRunning,
			daemonRunning: s.daemonRunning,
			error: s.error ? redact(s.error) : info.error,
		}
	}

	async logs(hostId: string, lines: number): Promise<HostLogs> {
		const sb = await this.find(hostId)
		if (!sb) throw new ProviderError('not_found', `no daytona host ${hostId}`)
		if (sb.state !== 'started') return { provider: 'daytona', hostId, bootstrap: '', daemon: '' }
		const { output } = await this.exec(sb, logsCommand(lines), 30)
		const parsed = parseLogsOutput(redact(output))
		return { provider: 'daytona', hostId, ...parsed }
	}

	async destroy(hostId: string): Promise<{ destroyed: boolean }> {
		const sb = await this.find(hostId)
		if (!sb) return { destroyed: false }
		const { status } = await this.api('DELETE', `/sandbox/${encodeURIComponent(sb.id)}`)
		return { destroyed: status !== 404 }
	}

	async list(): Promise<HostSummary[]> {
		const out: HostSummary[] = []
		let cursor: string | null = null
		for (let page = 0; page < 20; page++) {
			const q = new URLSearchParams({ labels: JSON.stringify({ app: 'humanlayer' }), limit: '100' })
			if (cursor) q.set('cursor', cursor)
			const { data } = await this.api<{ items: DaytonaSandbox[]; nextCursor?: string | null }>(
				'GET',
				`/sandbox?${q.toString()}`,
			)
			for (const sb of data?.items ?? []) {
				const hostId = sb.labels?.hostId
				if (!hostId || sb.state === 'destroyed') continue
				out.push({
					provider: 'daytona',
					hostId,
					sandboxId: sb.id,
					providerState: sb.state,
					createdAt: sb.createdAt ?? null,
					expiresAt: sb.autoDestroyAt ?? null,
				})
			}
			cursor = data?.nextCursor ?? null
			if (!cursor) break
		}
		return out
	}
}
