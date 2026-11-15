import type { CloudHostTokenGate } from './auth/cloud-host-revocation'
import type { DaemonTokenClaims } from './auth/daemon-token-core'
import type { AppRuntime } from './lib/effect/runtime'
import type { DbClient } from './lib/queries'

export type SimpleAuthContext = { organizationId: string; userId: string; hostId?: string }

export type AppConfig = {
	/** Electric SQL shape URL (required) */
	electricShapeUrl: string
	/** Electric secret for authenticated requests (optional in dev) */
	electricSecret?: string
	/** Durable Streams base URL (legacy input name); may include a path prefix. */
	durableStreamsOrigin: string
	/** Test auth context - if provided, bypasses real auth (for testing only) */
	testAuthContext?: SimpleAuthContext
	/** Application Effect runtime for auth, metrics, and proxy paths */
	effectRuntime: AppRuntime
	/** Daemon token validator for production daemon auth path */
	validateDaemonToken?: (token: string) => Promise<DaemonTokenClaims | null>
	/** Database client for routes that need DB access */
	db: DbClient
	/**
	 * Revocation check for cloud host daemon tokens. Defaults to a per-process cached lookup on
	 * `db` (auth/cloud-host-revocation.ts).
	 */
	cloudHostTokenGate?: CloudHostTokenGate
	/**
	 * Gzip responses in-process (default true). Disable where the platform compresses at the edge
	 * (Cloudflare Workers): there a `Content-Encoding` header makes the runtime encode the body
	 * itself, so compressing here would double-encode.
	 */
	compress?: boolean
}
