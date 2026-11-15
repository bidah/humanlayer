import { z } from 'zod'

export const PROVIDERS = ['cloudflare', 'daytona', 'e2b'] as const
export const ProviderName = z.enum(PROVIDERS)
export type ProviderName = z.infer<typeof ProviderName>

export const HostSize = z.enum(['small', 'medium', 'large'])
export type HostSize = z.infer<typeof HostSize>

/** Host ids are the daemon's host UUIDs (apps/cli/src/lib/host-id.ts uses crypto.randomUUID()). */
export const HostId = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'hostId must be a UUID')

/**
 * Variables the bootstrap owns. Callers may not override them through `env`: they would either
 * break the host (PATH/HOME) or bypass the dedicated `daemonToken` field.
 */
export const RESERVED_ENV_KEYS = new Set([
	'RIPTIDE_DAEMON_TOKEN',
	'HUMANLAYER_HOST_ID',
	'HUMANLAYER_HOST_PROVIDER',
	'HUMANLAYER_DISABLE_SELF_UPDATE',
	'HUMANLAYER_CLAUDE_PATH',
	'IS_SANDBOX',
	'HOME',
	'USER',
	'PATH',
	'SHELL',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'RIPTIDE_API_ORIGIN',
	'RIPTIDE_SYNC_ORIGIN',
	'RIPTIDE_CLOUD_ORIGIN',
	'RIPTIDE_APP_ORIGIN',
	'RIPTIDE_DAEMON_LOAD_CREDS',
	'RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY',
	'DAEMON_IDENTITY',
])

const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, 'env keys must be UPPER_SNAKE_CASE')

export const HostEnv = z
	.record(
		EnvKey,
		z
			.string()
			.max(16_384)
			.refine((v) => !v.includes('\0'), 'env values may not contain NUL'),
	)
	.default({})
	.superRefine((env, ctx) => {
		const keys = Object.keys(env)
		if (keys.length > 64) ctx.addIssue({ code: 'custom', message: 'at most 64 env entries' })
		for (const key of keys) {
			if (RESERVED_ENV_KEYS.has(key)) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is reserved` })
		}
	})

/** A compact JWT: three base64url segments. The provisioner never verifies it; the API does. */
export const DaemonToken = z
	.string()
	.min(20)
	.max(8192)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'daemonToken must be a compact JWT')

export const MAX_TTL_MINUTES = 30 * 24 * 60
export const DEFAULT_TTL_MINUTES = 24 * 60

export const CreateHostRequest = z.object({
	provider: ProviderName.default('cloudflare'),
	hostId: HostId,
	daemonToken: DaemonToken,
	env: HostEnv,
	ttlMinutes: z.number().int().min(10).max(MAX_TTL_MINUTES).default(DEFAULT_TTL_MINUTES),
	size: HostSize.default('medium'),
	/** Pin a CLI artifact version (R2 `cli/<version>/`); defaults to `cli/latest.json`. */
	cliVersion: z
		.string()
		.regex(/^[A-Za-z0-9._-]{1,80}$/)
		.optional(),
	/** Labels copied to the provider sandbox (Daytona labels / E2B metadata / container labels). */
	labels: z
		.record(z.string().regex(/^[a-zA-Z0-9_.-]{1,63}$/), z.string().max(255))
		.default({})
		.refine((l) => Object.keys(l).length <= 16, 'at most 16 labels'),
})
export type CreateHostRequest = z.infer<typeof CreateHostRequest>

export const RebootstrapRequest = z.object({
	daemonToken: DaemonToken,
	env: HostEnv,
	cliVersion: CreateHostRequest.shape.cliVersion,
})
export type RebootstrapRequest = z.infer<typeof RebootstrapRequest>

export const HostPathParams = z.object({ provider: ProviderName, hostId: HostId })

export const LogsQuery = z.object({
	lines: z.coerce.number().int().min(1).max(2000).default(200),
})

export const ListQuery = z.object({ provider: ProviderName.optional() })

/** Coarse lifecycle state, normalised across providers. */
export type HostState =
	| 'provisioning' // provider is creating/starting the sandbox
	| 'bootstrapping' // sandbox up, bootstrap script running
	| 'running' // daemon supervisor and daemon process are up
	| 'degraded' // bootstrap finished but daemon process not currently running (supervisor restarting it)
	| 'failed' // bootstrap failed (see `error`)
	| 'stopped' // sandbox exists but is not running
	| 'destroying'
	| 'not_found'

export type BootstrapPhase =
	| 'none'
	| 'starting'
	| 'packages'
	| 'user'
	| 'cli'
	| 'claude'
	| 'git'
	| 'daemon'
	| 'running'
	| 'failed'

export interface HostInfo {
	provider: ProviderName
	hostId: string
	/** Provider-native sandbox id (Daytona sandbox UUID, E2B sandboxID, Cloudflare DO name). */
	sandboxId: string | null
	state: HostState
	/** Raw provider state string, for debugging. */
	providerState: string | null
	bootstrapPhase: BootstrapPhase | null
	supervisorRunning: boolean | null
	daemonRunning: boolean | null
	error: string | null
	createdAt: string | null
	expiresAt: string | null
	size: HostSize | null
	cliVersion: string | null
}

export interface HostLogs {
	provider: ProviderName
	hostId: string
	bootstrap: string
	daemon: string
}
