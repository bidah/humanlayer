/**
 * Effect layers for the Cloudflare Worker build.
 *
 * Reuses the proxy services (ElectricProxyLive, DurableStreamsProxyLive, ResponseEditorGatewayLive,
 * JWTValidatorLive) and swaps only what is Node-specific:
 *
 * - upstream HTTP: undici pools + socket instrumentation -> Effect's FetchHttpClient over a fetch
 *   that routes the Electric / Durable Streams origins to their service bindings;
 * - pool / process / undici diagnostics metrics and their pollers -> dropped (no-op services);
 * - Sentry -> not provided (the SDK is aliased to a no-op shim in wrangler.jsonc);
 * - JWKS -> lazy, per-isolate cache without a background fiber (./jwks-cache.ts);
 * - WorkOS config -> the JWKS URL is derived directly from WORKOS_CLIENT_ID, so the Node-only
 *   WorkOS SDK is never constructed.
 *
 * Nothing here performs I/O or forks fibers at build time, so the ManagedRuntime can be built
 * lazily by the first request and shared by the isolate without crossing request I/O contexts.
 */
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/http'

import { JWKSConfig } from '@/auth/effect/jwks-cache-config.service'
import { JWTValidatorLive } from '@/auth/effect/jwt-validator.service'
import { ConnectionMetricsLive } from '@/lib/effect/connection-metrics.service'
import { DurableStreamsHttpClient } from '@/lib/effect/durable-streams-http-client.service'
import { DurableStreamsProxyLive } from '@/lib/effect/durable-streams-proxy.service'
import { ElectricProxyHttpClient } from '@/lib/effect/electric-http-client.service'
import { ElectricProxyLive } from '@/lib/effect/electric-proxy.service'
import { HttpPoolMetrics } from '@/lib/effect/http-pool-metrics.service'
import { ProcessResourceMetrics } from '@/lib/effect/process-resource-metrics.service'
import { ProxyRuntimeConfigLive, type ProxyRuntimeConfigValues } from '@/lib/effect/proxy-runtime-config.service'
import type { AppRuntime, AppRuntimeServices } from '@/lib/effect/runtime'
import { ResponseEditorGatewayLive } from '@/lib/effect/yjs-gateway.service'

import { WorkerJWKSCacheLive } from './jwks-cache'

const fetchHttpClient = (fetch: typeof globalThis.fetch) =>
	HttpClient.HttpClient.pipe(
		Effect.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))),
	)

const fetchHttpClientLayer = <I, S extends HttpClient.HttpClient>(
	tag: Context.Key<I, S>,
	fetch: typeof globalThis.fetch,
) => Layer.effect(tag, fetchHttpClient(fetch) as Effect.Effect<S>)

/** Pool and process metrics come from undici and /proc; neither exists on workerd. */
const NoopHttpPoolMetricsLive = Layer.succeed(HttpPoolMetrics, {
	registerPool: () => Effect.void,
	unregisterPool: () => Effect.void,
	snapshotPools: Effect.succeed([]),
})

const NoopProcessResourceMetricsLive = Layer.succeed(ProcessResourceMetrics, {
	snapshotFileDescriptors: Effect.succeed({ open: 0 }),
	recordFileDescriptorSnapshot: Effect.void,
})

export type WorkerAuthConfig = {
	/** WorkOS client id; the JWKS URL is `${workosApiBaseUrl}/sso/jwks/${clientId}`. */
	readonly workosClientId: string
	readonly workosApiBaseUrl?: string
	/** Optional explicit JWKS URL (overrides the WorkOS-derived one). */
	readonly jwksUrl?: string
}

export const workosJwksUrl = (config: WorkerAuthConfig) =>
	config.jwksUrl ??
	`${(config.workosApiBaseUrl ?? 'https://api.workos.com').replace(/\/+$/, '')}/sso/jwks/${config.workosClientId}`

export const makeWorkerAuthLayer = (config: WorkerAuthConfig) => {
	const jwksCacheLive = WorkerJWKSCacheLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(JWKSConfig, {
					jwksUrl: workosJwksUrl(config),
					keyFetchTimeoutMs: 10_000,
					refreshIntervalMs: 300_000,
				}),
				// JWKS is the only upstream reached over the public internet.
				Layer.effect(HttpClient.HttpClient, fetchHttpClient(globalThis.fetch.bind(globalThis))),
			),
		),
	)
	return JWTValidatorLive.pipe(Layer.provide(jwksCacheLive))
}

export const makeWorkerAppLayer = (options: {
	readonly proxyRuntimeConfig: ProxyRuntimeConfigValues
	/** fetch used for upstream calls; routes Electric / Durable Streams origins to service bindings. */
	readonly upstreamFetch: typeof globalThis.fetch
	readonly auth: WorkerAuthConfig
}) => {
	const runtimeConfigLive = ProxyRuntimeConfigLive(options.proxyRuntimeConfig)
	const electricHttpClientLive = fetchHttpClientLayer(ElectricProxyHttpClient, options.upstreamFetch)
	const durableStreamsHttpClientLive = fetchHttpClientLayer(DurableStreamsHttpClient, options.upstreamFetch)

	return Layer.mergeAll(
		runtimeConfigLive,
		ElectricProxyLive.pipe(Layer.provide(electricHttpClientLive)),
		DurableStreamsProxyLive.pipe(Layer.provide(durableStreamsHttpClientLive)),
		ResponseEditorGatewayLive.pipe(Layer.provide(Layer.mergeAll(runtimeConfigLive, durableStreamsHttpClientLive))),
		makeWorkerAuthLayer(options.auth),
		NoopHttpPoolMetricsLive,
		NoopProcessResourceMetricsLive,
	).pipe(Layer.provideMerge(ConnectionMetricsLive))
}

export const createWorkerAppRuntime = (layer: Layer.Layer<AppRuntimeServices, never, never>): AppRuntime =>
	ManagedRuntime.make(layer) as AppRuntime
