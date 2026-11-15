import type { HostInfo, HostLogs, HostSize, ProviderName } from '../schemas'

/** A resolved CLI artifact the sandbox will download. */
export interface CliArtifact {
	url: string
	sha256: string | null
	version: string | null
}

/** Everything a provider needs to bring a host up. Secrets live in `daemonToken` and `env`. */
export interface ProvisionInput {
	hostId: string
	daemonToken: string
	env: Record<string, string>
	ttlMinutes: number
	size: HostSize
	labels: Record<string, string>
	cli: CliArtifact
}

export interface RebootstrapInput {
	hostId: string
	daemonToken: string
	env: Record<string, string>
	cli: CliArtifact
}

export interface CreateResult {
	host: HostInfo
	/** false when a sandbox for this hostId already existed (create is idempotent). */
	created: boolean
	timings?: Record<string, number>
}

export interface HostSummary {
	provider: ProviderName
	hostId: string
	sandboxId: string | null
	providerState: string | null
	createdAt: string | null
	expiresAt: string | null
}

/**
 * A cloud sandbox backend that can run one HumanLayer daemon host per hostId.
 * Implementations are stateless: the hostId is encoded in the sandbox name/labels/metadata.
 */
export interface CloudHostProvider {
	readonly name: ProviderName
	/** Create the sandbox (idempotent per hostId) and start the bootstrap in the background. */
	create(input: ProvisionInput): Promise<CreateResult>
	/** Re-upload credentials and re-run the idempotent bootstrap (e.g. token rotation). */
	rebootstrap(input: RebootstrapInput): Promise<HostInfo>
	status(hostId: string): Promise<HostInfo>
	logs(hostId: string, lines: number): Promise<HostLogs>
	/** Returns false when there was nothing to destroy. */
	destroy(hostId: string): Promise<{ destroyed: boolean }>
	list(): Promise<HostSummary[]>
}

export type ProviderErrorCode = 'not_configured' | 'not_found' | 'invalid_request' | 'provider_error' | 'timeout'

const HTTP_STATUS_BY_CODE: Record<ProviderErrorCode, number> = {
	not_configured: 501,
	not_found: 404,
	invalid_request: 400,
	timeout: 504,
	provider_error: 502,
}

export class ProviderError extends Error {
	constructor(
		readonly code: ProviderErrorCode,
		message: string,
		readonly httpStatus: number = HTTP_STATUS_BY_CODE[code],
	) {
		super(message)
		this.name = 'ProviderError'
	}
}

export function emptyHostInfo(provider: ProviderName, hostId: string): HostInfo {
	return {
		provider,
		hostId,
		sandboxId: null,
		state: 'not_found',
		providerState: null,
		bootstrapPhase: null,
		supervisorRunning: null,
		daemonRunning: null,
		error: null,
		createdAt: null,
		expiresAt: null,
		size: null,
		cliVersion: null,
	}
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
