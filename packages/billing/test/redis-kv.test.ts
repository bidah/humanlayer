import { describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { expect } from 'vitest'

import { BillingKvService, BillingKvServiceLive } from '../src/billing-kv/billing-kv.service'
import { stripeBillingKeys } from '../src/keys'
import { type KvNamespaceLike, makeRedisKvLive } from '../src/redis/redis-kv-live'
import { RedisService } from '../src/redis/redis-service'

const makeMemoryKv = () => {
	const values = new Map<string, string>()
	const kv: KvNamespaceLike = {
		get: async (key) => values.get(key) ?? null,
		put: async (key, value) => {
			values.set(key, value)
		},
		delete: async (key) => {
			values.delete(key)
		},
	}
	return { kv, values }
}

describe('makeRedisKvLive', () => {
	it.effect('backs BillingKvService with Workers KV using the same keys', () => {
		const { kv, values } = makeMemoryKv()
		return Effect.gen(function* () {
			const billingKv = yield* BillingKvService
			expect(yield* billingKv.getOrgCustomerId({ organizationId: 'org_1' })).toBeNull()
			yield* billingKv.setOrgCustomerId({ organizationId: 'org_1', customerId: 'cus_1' })
			yield* billingKv.setCustomerOrgId({ customerId: 'cus_1', organizationId: 'org_1' })
			expect(yield* billingKv.getOrgCustomerId({ organizationId: 'org_1' })).toBe('cus_1')
			expect(yield* billingKv.getCustomerOrgId({ customerId: 'cus_1' })).toBe('org_1')
			expect(values.get(stripeBillingKeys.orgCustomer('org_1'))).toBe('cus_1')
			expect(values.get(stripeBillingKeys.customerOrg('cus_1'))).toBe('org_1')
		}).pipe(Effect.provide(BillingKvServiceLive.pipe(Layer.provideMerge(makeRedisKvLive(kv)))))
	})

	it.effect('returns Redis-shaped replies and maps KV failures to RedisCommandError', () => {
		const { kv } = makeMemoryKv()
		const failing: KvNamespaceLike = { ...kv, get: async () => Promise.reject(new Error('kv down')) }
		return Effect.gen(function* () {
			const redis = yield* RedisService
			expect(yield* redis.send('SET', 'k', 'v')).toBe('OK')
			expect(yield* redis.send('GET', 'k')).toBe('v')
			expect(yield* redis.send('DEL', 'k')).toBe(1)
			expect(yield* redis.send('DEL', 'k')).toBe(0)
			expect(yield* redis.send('PING')).toBe('PONG')

			const error = yield* Effect.flip(
				Effect.gen(function* () {
					const failingRedis = yield* RedisService
					return yield* failingRedis.send('GET', 'k')
				}).pipe(Effect.provide(makeRedisKvLive(failing))),
			)
			expect(error._tag).toBe('RedisCommandError')
		}).pipe(Effect.provide(makeRedisKvLive(kv)))
	})
})
