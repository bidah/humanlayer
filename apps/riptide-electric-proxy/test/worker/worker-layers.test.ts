import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { HttpClient } from 'effect/http'
import { FetchHttpClient } from 'effect/http'
import { exportJWK, generateKeyPair } from 'jose'

import { JWKSConfig } from '@/auth/effect/jwks-cache-config.service'
import { JWKSCache } from '@/auth/effect/jwks-cache.service'
import { makeBindingFetch, UpstreamBindingMissingError } from '@/worker/binding-fetch'
import { WorkerJWKSCacheLive } from '@/worker/jwks-cache'
import { workosJwksUrl } from '@/worker/runtime'

const recordingBinding = (name: string, calls: string[]) => ({
	fetch: async (input: Request | string | URL) => {
		const request = input instanceof Request ? input : new Request(input.toString())
		calls.push(`${name} ${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)
		return new Response(name)
	},
})

describe('makeBindingFetch', () => {
	it('routes configured origins to their bindings and everything else to the fallback', async () => {
		const calls: string[] = []
		const fetch = makeBindingFetch(
			[
				{
					bindingName: 'ELECTRIC',
					origin: 'http://human-flare-electric',
					binding: recordingBinding('electric', calls),
				},
				{
					bindingName: 'STREAMS',
					origin: 'http://human-flare-streams',
					binding: recordingBinding('streams', calls),
				},
			],
			async (input) => {
				calls.push(`fallback ${input.toString()}`)
				return new Response('fallback')
			},
		)

		expect(await (await fetch('http://human-flare-electric/v1/shape?table=x&secret=s')).text()).toBe('electric')
		expect(await (await fetch('http://human-flare-streams/v1/stream/a/b', { method: 'PUT' })).text()).toBe('streams')
		expect(await (await fetch('https://api.workos.com/sso/jwks/client_x')).text()).toBe('fallback')
		expect(calls).toEqual([
			'electric GET /v1/shape?table=x&secret=s',
			'streams PUT /v1/stream/a/b',
			'fallback https://api.workos.com/sso/jwks/client_x',
		])
	})

	it('fails loudly when the binding is not configured', async () => {
		const fetch = makeBindingFetch([
			{ bindingName: 'STREAMS', origin: 'http://human-flare-streams', binding: undefined },
		])
		await expect(fetch('http://human-flare-streams/v1/stream/x')).rejects.toBeInstanceOf(UpstreamBindingMissingError)
	})
})

describe('workosJwksUrl', () => {
	it('derives the WorkOS JWKS URL like the WorkOS SDK', () => {
		expect(workosJwksUrl({ workosClientId: 'client_123' })).toBe('https://api.workos.com/sso/jwks/client_123')
		expect(workosJwksUrl({ workosClientId: 'c', jwksUrl: 'http://x/jwks' })).toBe('http://x/jwks')
	})
})

describe('WorkerJWKSCacheLive', () => {
	const makeLayer = async (fetchCount: { n: number }) => {
		const { publicKey } = await generateKeyPair('RS256')
		const jwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'RS256' }
		const fetch = (async () => {
			fetchCount.n++
			return Response.json({ keys: [jwk] })
		}) as unknown as typeof globalThis.fetch
		return WorkerJWKSCacheLive.pipe(
			Layer.provide(
				Layer.succeed(JWKSConfig, {
					jwksUrl: 'http://jwks.test/jwks',
					keyFetchTimeoutMs: 1000,
					refreshIntervalMs: 60_000,
				}),
			),
			Layer.provide(
				Layer.effect(
					HttpClient.HttpClient,
					HttpClient.HttpClient.pipe(
						Effect.provide(
							FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
						),
					),
				),
			),
		)
	}

	it.effect('does no I/O at build time, fetches lazily, caches, and cools down on unknown kids', () =>
		Effect.gen(function* () {
			const fetchCount = { n: 0 }
			const layer = yield* Effect.promise(() => makeLayer(fetchCount))
			yield* Effect.gen(function* () {
				const cache = yield* JWKSCache
				expect(fetchCount.n).toBe(0)
				expect(yield* cache.isReady).toBe(false)

				yield* cache.getKey('kid-1')
				yield* cache.getKey('kid-1')
				expect(fetchCount.n).toBe(1)

				const missing = yield* cache.getKey('unknown').pipe(Effect.flip)
				expect(missing._tag).toBe('JWKSKeyNotFoundError')
				yield* cache.forceRefresh
				expect(fetchCount.n).toBe(1)
			}).pipe(Effect.provide(layer))
		}),
	)
})
