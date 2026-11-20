/**
 * Cloudflare Worker entrypoint (`human-flare-sync`). The Node entrypoint (index.ts) stays untouched.
 *
 * Same Hono app as Node (createApp), with Worker replacements for the Node-only pieces:
 * - upstream HTTP goes over the ELECTRIC / STREAMS service bindings (worker/binding-fetch.ts);
 * - Postgres ACL checks use a per-request postgres.js client over Hyperdrive (worker/db.ts);
 * - JWKS is cached per isolate and fetched lazily (worker/jwks-cache.ts);
 * - Sentry is aliased to a no-op shim in wrangler.jsonc (worker/sentry-shim.ts);
 * - response compression is left to Cloudflare's edge.
 *
 * Vars and secrets: with `nodejs_compat` and a compatibility date >= 2025-04-01, workerd populates
 * `process.env` with string vars/secrets before any module is evaluated, so the import-time reads
 * in lib/logger.ts, connection-metrics.service.ts, sentry.service.ts and Effect's default
 * ConfigProvider see them. The values the Worker needs are read from `env` below regardless.
 */
import type { ExecutionContext, Hono } from 'hono'

import { createApp } from './app'
import { makeProxyRuntimeConfig } from './lib/effect/proxy-runtime-config.service'
import { logger } from './lib/logger'
import { makeBindingFetch, type ServiceBinding } from './worker/binding-fetch'
import { makeDaemonTokenValidator } from './worker/daemon-token'
import { RequestDbScope, requestScopedDb, runWithRequestDb } from './worker/db'
import { createWorkerAppRuntime, makeWorkerAppLayer } from './worker/runtime'

/** Structural subset of the Worker bindings this entrypoint uses (no global workers-types needed). */
export type WorkerEnv = {
	/** Electric 1.7.x behind the `human-flare-electric` Worker. Optional so the Worker can boot without it. */
	ELECTRIC?: ServiceBinding
	/** Durable Streams behind the `human-flare-streams` Worker. Optional for the same reason. */
	STREAMS?: ServiceBinding
	HYPERDRIVE: { connectionString: string }

	/** Routing keys only: requests to these origins are sent to the bindings above. */
	ELECTRIC_SHAPE_URL?: string
	DURABLE_STREAMS_ORIGIN?: string

	ELECTRIC_SECRET?: string
	RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY?: string
	WORKOS_CLIENT_ID?: string
	WORKOS_API_HOSTNAME?: string
	WORKOS_JWKS_URL?: string
	LOG_LEVEL?: string
}

const DEFAULT_ELECTRIC_SHAPE_URL = 'http://human-flare-electric/v1/shape'
const DEFAULT_DURABLE_STREAMS_ORIGIN = 'http://human-flare-streams'

function buildApp(env: WorkerEnv) {
	const electricShapeUrl = env.ELECTRIC_SHAPE_URL || DEFAULT_ELECTRIC_SHAPE_URL
	const durableStreamsOrigin = env.DURABLE_STREAMS_ORIGIN || DEFAULT_DURABLE_STREAMS_ORIGIN
	const proxyRuntimeConfig = makeProxyRuntimeConfig({ electricShapeUrl, durableStreamsOrigin })

	if (!env.ELECTRIC) logger.warn('ELECTRIC service binding missing; shape routes will return 502')
	if (!env.STREAMS) logger.warn('STREAMS service binding missing; stream routes will return 502')
	if (!env.ELECTRIC_SECRET) logger.warn('ELECTRIC_SECRET not set; Electric requests are unauthenticated')
	if (!env.RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY)
		logger.warn('RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY not set; daemon auth disabled')

	const upstreamFetch = makeBindingFetch([
		{ bindingName: 'ELECTRIC', origin: proxyRuntimeConfig.electricOrigin, binding: env.ELECTRIC },
		{ bindingName: 'STREAMS', origin: proxyRuntimeConfig.durableStreamsOrigin, binding: env.STREAMS },
	])

	const effectRuntime = createWorkerAppRuntime(
		makeWorkerAppLayer({
			proxyRuntimeConfig,
			upstreamFetch,
			auth: {
				workosClientId: env.WORKOS_CLIENT_ID || 'client_WORKOS_NOT_CONFIGURED',
				workosApiBaseUrl: env.WORKOS_API_HOSTNAME ? `https://${env.WORKOS_API_HOSTNAME}` : undefined,
				jwksUrl: env.WORKOS_JWKS_URL || undefined,
			},
		}),
	)

	return createApp({
		electricShapeUrl,
		electricSecret: env.ELECTRIC_SECRET || undefined,
		durableStreamsOrigin,
		effectRuntime,
		validateDaemonToken: makeDaemonTokenValidator(env.RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY),
		db: requestScopedDb,
		compress: false,
	})
}

// One app + Effect runtime per isolate. Building them performs no I/O, so it is safe to do inside
// whichever request arrives first; bindings on `env` are not tied to that request.
let app: Hono | undefined

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
		const currentApp = (app ??= buildApp(env))
		const dbScope = new RequestDbScope(env.HYPERDRIVE.connectionString)
		try {
			return await runWithRequestDb(dbScope, () => currentApp.fetch(request, env, ctx))
		} finally {
			// ACL queries finish before the handler returns; streaming bodies never touch the DB.
			ctx.waitUntil(dbScope.close())
		}
	},
}
