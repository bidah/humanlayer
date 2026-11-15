import { afterEach, describe, expect, it, vi } from 'vitest'

import { type BackgroundJobMessage, backgroundQueueEnabled, dispatchBackgroundJob } from './background-jobs'
import { drainBackground, makeRequestScope, runWithRequestScope } from './request-scope'
import { setWorkerEnv, type WorkerEnv } from './worker-env'

afterEach(() => {
	// Module-level env: never leak a fake queue into other test files (shared module registry).
	setWorkerEnv(undefined as unknown as WorkerEnv)
})

describe('dispatchBackgroundJob', () => {
	it('runs the in-process function when no queue is bound (Node path)', async () => {
		const inProcess = vi.fn(async () => {
			throw new Error('swallowed like the fire-and-forget call sites')
		})
		expect(backgroundQueueEnabled()).toBe(false)
		await expect(
			dispatchBackgroundJob(
				'session.generate-title',
				{ sessionId: 's', organizationId: 'o', userId: 'u' },
				{ inProcess },
			),
		).resolves.toBeUndefined()
		expect(inProcess).toHaveBeenCalledTimes(1)
	})

	it('sends an id-only envelope to the queue, with clamped delay, tracked by waitUntil', async () => {
		const sent: Array<{ body: BackgroundJobMessage; options: unknown }> = []
		setWorkerEnv({
			BACKGROUND_QUEUE: {
				send: async (body, options) => {
					sent.push({ body: body as BackgroundJobMessage, options })
				},
			},
		})
		const waited: Array<Promise<unknown>> = []
		const scope = makeRequestScope((promise) => waited.push(promise))
		const inProcess = vi.fn()

		await runWithRequestScope(scope, () =>
			dispatchBackgroundJob(
				'github.refresh-merge-state',
				{ installationId: '1', repoFullName: 'o/r', branch: 'b' },
				{ delaySeconds: 14.2, inProcess },
			),
		)
		await runWithRequestScope(scope, () =>
			dispatchBackgroundJob('ops.probe', { note: 'n' }, { delaySeconds: 10 ** 9, inProcess }),
		)
		await drainBackground(scope)

		expect(inProcess).not.toHaveBeenCalled()
		expect(waited).toHaveLength(2)
		expect(sent[0]?.body).toMatchObject({
			v: 1,
			job: 'github.refresh-merge-state',
			payload: { installationId: '1', repoFullName: 'o/r', branch: 'b' },
		})
		expect(sent[0]?.options).toEqual({ contentType: 'json', delaySeconds: 15 })
		expect(sent[1]?.options).toEqual({ contentType: 'json', delaySeconds: 86_400 })
		expect(JSON.parse(JSON.stringify(sent[0]?.body))).toEqual(sent[0]?.body)
	})

	it('never rejects when the send fails', async () => {
		setWorkerEnv({
			BACKGROUND_QUEUE: {
				send: async () => {
					throw new Error('queue unavailable')
				},
			},
		})
		await expect(
			dispatchBackgroundJob('ops.probe', { note: 'n' }, { inProcess: () => undefined }),
		).resolves.toBeUndefined()
	})
})
