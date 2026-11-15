import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
	drainBackground,
	makeRequestScope,
	runCleanups,
	runWithRequestScope,
	trackBackground,
	trackBackgroundFiber,
} from './request-scope'

describe('request scope (Cloudflare Worker background-work seam)', () => {
	it('is a no-op outside a request scope (Node path)', async () => {
		const promise = Promise.resolve(1)
		expect(trackBackground(promise)).toBe(promise)
		await expect(promise).resolves.toBe(1)
	})

	it('hands tracked promises and detached fibers to waitUntil and drains them, including nested ones', async () => {
		const waited: Array<Promise<unknown>> = []
		const scope = makeRequestScope((promise) => waited.push(promise))
		const order: string[] = []

		runWithRequestScope(scope, () => {
			void trackBackground(
				new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
					order.push('promise')
					// Work scheduled by background work is tracked too.
					void trackBackground(Promise.resolve().then(() => order.push('nested')))
				}),
			)
			trackBackgroundFiber(
				Effect.runFork(Effect.sleep('20 millis').pipe(Effect.andThen(Effect.sync(() => order.push('fiber'))))),
			)
			// Rejections are swallowed by the tracker (callers own error reporting).
			void trackBackground(Promise.reject(new Error('ignored'))).catch(() => undefined)
		})
		scope.cleanups.push(() => {
			order.push('cleanup')
		})

		expect(waited.length).toBe(3)
		await drainBackground(scope)
		await runCleanups(scope)
		expect(order).toEqual(['promise', 'nested', 'fiber', 'cleanup'])
		expect(scope.pending.size).toBe(0)
	})
})
