/**
 * Worker implementation of the JWKSCache service.
 *
 * The Node layer (auth/effect/jwks-cache.service.ts) blocks layer construction on a first fetch and
 * forks a 5-minute background refresh fiber. Neither fits workerd: there is no request context at
 * layer-build time, and a long-lived fiber would issue I/O on behalf of whichever request happened
 * to build the runtime. This layer instead:
 *
 * - fetches lazily, inside the request that needs a key;
 * - keeps imported keys in a per-isolate cache (CryptoKeys are plain values, safe to share);
 * - refreshes when the cache is older than `refreshIntervalMs` or a kid is missing, with a cooldown
 *   so a flood of unknown kids cannot hammer the JWKS endpoint;
 * - never shares an in-flight promise between requests (a promise settled by request A must not
 *   resume request B), so concurrent cold requests each fetch on their own.
 *
 * A stale cache is still served when a refresh fails, so a WorkOS blip does not log everyone out.
 */
import { Clock, Duration, Effect, Layer } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'
import { importJWK } from 'jose'

import {
	JWKSFetchError,
	JWKSFetchTimeoutError,
	JWKSKeyImportError,
	JWKSKeyNotFoundError,
	JWKSNotReadyError,
} from '@/auth/effect/errors'
import { JWKSResponse } from '@/auth/effect/jwk.schema'
import { JWKSConfig } from '@/auth/effect/jwks-cache-config.service'
import { JWKSCache } from '@/auth/effect/jwks-cache.service'
import { logger } from '@/lib/logger'

/** Minimum time between two refreshes triggered by an unknown kid. */
const MISSING_KID_REFRESH_COOLDOWN_MS = 30_000

type CacheState = {
	ready: boolean
	keys: Map<string, CryptoKey>
	fetchedAt: number
	lastAttemptAt: number
}

export const WorkerJWKSCacheLive = Layer.effect(
	JWKSCache,
	Effect.gen(function* () {
		const config = yield* JWKSConfig
		const httpClient = yield* HttpClient.HttpClient
		const state: CacheState = {
			ready: false,
			keys: new Map(),
			fetchedAt: Number.NEGATIVE_INFINITY,
			lastAttemptAt: Number.NEGATIVE_INFINITY,
		}

		const fetchKeys = HttpClientRequest.get(config.jwksUrl).pipe(
			httpClient.execute,
			Effect.flatMap(HttpClientResponse.filterStatusOk),
			Effect.flatMap(HttpClientResponse.schemaBodyJson(JWKSResponse)),
			Effect.mapError((error) => new JWKSFetchError({ message: 'Failed to fetch JWKS', cause: String(error) })),
			Effect.timeoutOrElse({
				duration: Duration.millis(config.keyFetchTimeoutMs),
				orElse: () => Effect.fail(new JWKSFetchTimeoutError()),
			}),
			Effect.scoped,
			Effect.flatMap((response) =>
				Effect.forEach(
					response.keys.filter((jwk) => jwk.kid),
					(jwk) =>
						Effect.tryPromise({
							try: () => importJWK(jwk) as Promise<CryptoKey>,
							catch: (error) => new JWKSKeyImportError({ kid: jwk.kid ?? '', cause: String(error) }),
						}).pipe(Effect.map((key) => [jwk.kid as string, key] as const)),
				),
			),
		)

		const refresh = Effect.gen(function* () {
			state.lastAttemptAt = yield* Clock.currentTimeMillis
			const entries = yield* fetchKeys
			state.keys = new Map(entries)
			state.ready = true
			state.fetchedAt = yield* Clock.currentTimeMillis
			logger.info({ keyCount: entries.length }, 'JWKS cache refreshed')
		}).pipe(
			Effect.tapError((error) =>
				Effect.sync(() => logger.warn({ error: { _tag: error._tag } }, 'JWKS refresh failed')),
			),
		)

		const isStale = Clock.currentTimeMillis.pipe(
			Effect.map((now) => now - state.fetchedAt >= config.refreshIntervalMs),
		)
		const inCooldown = Clock.currentTimeMillis.pipe(
			Effect.map((now) => now - state.lastAttemptAt < MISSING_KID_REFRESH_COOLDOWN_MS),
		)

		const getKey = (kid: string) =>
			Effect.gen(function* () {
				if ((yield* isStale) || (!state.keys.has(kid) && !(yield* inCooldown))) {
					// Serve whatever we have if the refresh fails.
					yield* refresh.pipe(Effect.ignore)
				}
				if (!state.ready) return yield* Effect.fail(new JWKSNotReadyError())
				const key = state.keys.get(kid)
				if (!key) {
					logger.error({ kid }, 'Key not found for kid')
					return yield* Effect.fail(new JWKSKeyNotFoundError({ kid }))
				}
				return key
			})

		return JWKSCache.of({
			getKey,
			isReady: Effect.sync(() => state.ready),
			// JWTValidator calls this after a miss; getKey already refreshed (or is cooling down).
			forceRefresh: inCooldown.pipe(Effect.flatMap((cooling) => (cooling ? Effect.void : refresh))),
		})
	}),
)
