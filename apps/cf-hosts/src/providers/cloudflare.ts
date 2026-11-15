import type { HostCreateParams, HostCreateResult, HostMeta } from '../cloudflare/host-sandbox'
import type { HostInfo, HostLogs } from '../schemas'
import {
	type CloudHostProvider,
	type CreateResult,
	emptyHostInfo,
	type HostSummary,
	ProviderError,
	type ProvisionInput,
	type RebootstrapInput,
} from './types'

/** The RPC surface of HostSandbox this provider uses (kept narrow so tests can fake it). */
export interface HostSandboxStub {
	hlCreate(p: HostCreateParams): Promise<HostCreateResult>
	hlRebootstrap(p: Omit<HostCreateParams, 'ttlMinutes' | 'labels'>): Promise<HostInfo | null>
	hlStatus(): Promise<HostInfo>
	hlLogs(lines: number): Promise<HostLogs | null>
	hlDestroy(reason?: string): Promise<{ destroyed: boolean }>
	hlMeta(): Promise<HostMeta | null>
}

export interface RegistryStub {
	list(): Promise<Array<{ hostId: string; createdAt: string; expiresAt: string }>>
}

export interface CloudflareDeps {
	sandbox(hostId: string): HostSandboxStub
	registry(): RegistryStub
}

export class CloudflareProvider implements CloudHostProvider {
	readonly name = 'cloudflare' as const

	constructor(private readonly deps: CloudflareDeps) {}

	async create(input: ProvisionInput): Promise<CreateResult> {
		const r = await this.deps.sandbox(input.hostId).hlCreate({
			hostId: input.hostId,
			daemonToken: input.daemonToken,
			env: input.env,
			ttlMinutes: input.ttlMinutes,
			labels: input.labels,
			cli: input.cli,
		})
		return { created: r.created, host: r.host, timings: r.timings }
	}

	async rebootstrap(input: RebootstrapInput): Promise<HostInfo> {
		const r = await this.deps.sandbox(input.hostId).hlRebootstrap({
			hostId: input.hostId,
			daemonToken: input.daemonToken,
			env: input.env,
			cli: input.cli,
		})
		if (!r) throw new ProviderError('not_found', `no cloudflare host ${input.hostId}`)
		return r
	}

	async status(hostId: string): Promise<HostInfo> {
		const s = await this.deps.sandbox(hostId).hlStatus()
		return s.state === 'not_found' ? emptyHostInfo('cloudflare', hostId) : s
	}

	async logs(hostId: string, lines: number): Promise<HostLogs> {
		const l = await this.deps.sandbox(hostId).hlLogs(lines)
		if (!l) throw new ProviderError('not_found', `no cloudflare host ${hostId}`)
		return l
	}

	destroy(hostId: string): Promise<{ destroyed: boolean }> {
		return this.deps.sandbox(hostId).hlDestroy()
	}

	async list(): Promise<HostSummary[]> {
		const entries = await this.deps.registry().list()
		return entries.map((e) => ({
			provider: 'cloudflare' as const,
			hostId: e.hostId,
			sandboxId: e.hostId,
			providerState: null,
			createdAt: e.createdAt,
			expiresAt: e.expiresAt,
		}))
	}
}
