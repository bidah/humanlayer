import { Effect, Layer } from 'effect'

import { RedisCommandError, RedisService } from './redis-service'

/**
 * The subset of a Cloudflare Workers KV namespace binding this layer uses. Declared structurally
 * so the billing package does not depend on `@cloudflare/workers-types`.
 */
export interface KvNamespaceLike {
	get(key: string): Promise<string | null>
	put(key: string, value: string): Promise<void>
	delete(key: string): Promise<void>
}

/**
 * `RedisService` backed by Workers KV, for the Cloudflare deployment where ioredis cannot hold a
 * long-lived TCP connection. It implements only the commands the billing cache issues (GET/SET of
 * plain string keys, plus DEL/PING) with Redis-shaped replies, so `BillingKvService` runs
 * unchanged on top of it.
 *
 * KV is eventually consistent across locations (writes can take up to ~60 s to be visible
 * elsewhere). The billing cache tolerates that: Stripe stays the source of truth and webhooks
 * re-sync the cache.
 *
 * This module must not import ioredis, so it is exported separately from the `./redis` barrel.
 */
export const makeRedisKvLive = (kv: KvNamespaceLike) =>
	Layer.succeed(
		RedisService,
		RedisService.of({
			send: (command, ...args) => {
				const run = (): Promise<unknown> => {
					switch (command) {
						case 'GET':
							return kv.get(requireKey(args))
						case 'SET': {
							const key = requireKey(args)
							const value = args[1]
							if (value === undefined) throw new Error('SET requires a value')
							if (args.length > 2) throw new Error('SET options are not supported by the KV backend')
							return kv.put(key, value).then(() => 'OK')
						}
						case 'DEL': {
							const key = requireKey(args)
							return kv.get(key).then(async (existing) => {
								if (existing === null) return 0
								await kv.delete(key)
								return 1
							})
						}
						case 'PING':
							return Promise.resolve('PONG')
						case 'CLUSTER':
							throw new Error('CLUSTER is not supported by the KV backend')
					}
				}
				return Effect.tryPromise({
					try: () => Promise.resolve().then(run),
					catch: (cause) => new RedisCommandError({ command, cause }),
				}).pipe(Effect.withSpan('redis.send', { attributes: { redis_mode: 'kv', redis_command: command } }))
			},
		}),
	)

const requireKey = (args: ReadonlyArray<string>): string => {
	const key = args[0]
	if (key === undefined || key.length === 0) throw new Error('A key is required')
	return key
}
