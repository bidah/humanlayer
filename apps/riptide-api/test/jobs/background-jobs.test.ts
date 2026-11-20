import { randomUUID } from 'node:crypto'

import { conversationEvents } from '@humanlayer/db/tables/conversation-events'
import { organizations } from '@humanlayer/db/tables/organizations'
import { sessions } from '@humanlayer/db/tables/sessions'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import type { AppRuntime } from '../../src/effects/app-runtime'
import { handleBackgroundQueueBatch, type QueueMessageLike, retryDelaySeconds } from '../../src/jobs/consumer'
import { runBackgroundJob, UnknownBackgroundJobError } from '../../src/jobs/registry'
import { generateSessionTitleFromStoredPrompt } from '../../src/lib/session-title-generation'
import { runExtractionThenAutoAdvanceJob } from '../../src/orpc/daemon/sessions/update'
import { getRequestScope } from '../../src/platform/request-scope'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

function fakeMessage(body: unknown, attempts = 1) {
	const message = {
		id: randomUUID(),
		body,
		attempts,
		ack: vi.fn(),
		retry: vi.fn(),
	} satisfies QueueMessageLike
	return message
}

describe('background queue consumer', () => {
	test('acks successes and retries failures individually, each in its own request scope', async () => {
		const ok = fakeMessage({ job: 'a' })
		const bad = fakeMessage({ job: 'b' }, 2)
		const scopes = new Set<unknown>()
		const cleanups: string[] = []
		const run = vi.fn(async (body: unknown) => {
			const scope = getRequestScope()
			expect(scope).toBeDefined()
			scopes.add(scope)
			scope?.cleanups.push(() => {
				cleanups.push((body as { job: string }).job)
			})
			if ((body as { job: string }).job === 'b') throw new Error('boom')
			return { result: 'done' }
		})

		await handleBackgroundQueueBatch({ queue: 'human-flare-background', messages: [ok, bad] }, () => undefined, run)

		expect(ok.ack).toHaveBeenCalledTimes(1)
		expect(ok.retry).not.toHaveBeenCalled()
		expect(bad.ack).not.toHaveBeenCalled()
		expect(bad.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
		expect(scopes.size).toBe(2)
		// The per-message scope is torn down (DB client closed) even when the job fails.
		expect(cleanups).toEqual(['a', 'b'])
	})

	test('backoff grows and is capped', () => {
		expect([1, 2, 3, 4, 10].map(retryDelaySeconds)).toEqual([10, 30, 90, 270, 900])
	})

	test('rejects malformed envelopes and unknown jobs (so they are retried, then dead-lettered)', async () => {
		await expect(runBackgroundJob({ job: 'ops.probe' })).rejects.toThrow()
		await expect(
			runBackgroundJob({ v: 1, job: 'nope', payload: {}, enqueuedAt: Date.now() }),
		).rejects.toBeInstanceOf(UnknownBackgroundJobError)
		await expect(
			runBackgroundJob({ v: 1, job: 'session.generate-title', payload: { sessionId: 1 }, enqueuedAt: 0 }),
		).rejects.toThrow()
		await expect(
			runBackgroundJob({ v: 1, job: 'ops.probe', payload: { note: 'x', fail: true }, enqueuedAt: 0 }),
		).rejects.toThrow('failing on purpose')
		await expect(
			runBackgroundJob({ v: 1, job: 'ops.probe', payload: { note: 'x' }, enqueuedAt: 0 }),
		).resolves.toEqual({ job: 'ops.probe', result: undefined })
	})
})

describe('background job handlers check current state (at-least-once delivery)', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let organizationId: string
	const userId = 'user_jobs'
	const runtime = { runFork: vi.fn() } as unknown as AppRuntime

	beforeAll(async () => {
		const testDb = await createTestDb('background_jobs')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		const [org] = await db
			.insert(organizations)
			.values({ name: 'jobs org', workos_organization_id: `org_${randomUUID()}` })
			.returning()
		if (!org) throw new Error('Unable to insert organization')
		organizationId = org.id
	}, 60000)

	afterAll(async () => {
		await cleanupTestDb?.()
	}, 30000)

	async function insertSession(values: { title?: string | null; prompt?: string | null } = {}) {
		const [session] = await db
			.insert(sessions)
			.values({
				organization_id: organizationId,
				resource_owner_user_id: userId,
				created_by: userId,
				host_id: randomUUID(),
				title: values.title ?? null,
				prompt: values.prompt ?? null,
				working_directory: '/tmp/test',
				coding_agent: 'claude',
				provider: 'anthropic',
				model: 'claude-sonnet-4-5',
				permissions_mode: 'default',
				status: 'ready_for_input',
			})
			.returning()
		if (!session) throw new Error('Unable to insert session')
		return session
	}

	async function insertAssistantMessage(sessionId: string, extracted: boolean, createdAt: bigint) {
		const [event] = await db
			.insert(conversationEvents)
			.values({
				session_id: sessionId,
				organization_id: organizationId,
				resource_owner_user_id: userId,
				event_type: 'message',
				role: 'assistant',
				content: 'done; next run the plan skill',
				next_step_suggestion: extracted
					? ({ parsedAt: 1, extraction: { type: 'no_next_step', reason: 'test' } } as never)
					: null,
				created_at: createdAt,
			})
			.returning()
		if (!event) throw new Error('Unable to insert event')
		return event
	}

	test('session.generate-title skips sessions that are already titled, missing, or without a prompt', async () => {
		const titled = await insertSession({ title: 'kept', prompt: 'do things' })
		const noPrompt = await insertSession({ prompt: null })
		for (const sessionId of [titled.id, noPrompt.id, randomUUID()]) {
			await expect(generateSessionTitleFromStoredPrompt(db, { sessionId, organizationId, userId })).resolves.toBe(
				'skipped',
			)
		}
		const [row] = await db.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, titled.id))
		expect(row?.title).toBe('kept')
	})

	test('next-step job is superseded when a newer assistant message exists', async () => {
		const session = await insertSession()
		const older = await insertAssistantMessage(session.id, false, 1000n)
		await insertAssistantMessage(session.id, false, 2000n)

		await expect(
			runExtractionThenAutoAdvanceJob(
				db,
				{ sessionId: session.id, organizationId, userId, eventId: older.id },
				runtime,
			),
		).resolves.toBe('superseded')
		const [row] = await db
			.select({ suggestion: conversationEvents.next_step_suggestion })
			.from(conversationEvents)
			.where(eq(conversationEvents.id, older.id))
		expect(row?.suggestion).toBeNull()
	})

	test('next-step job does not re-extract an already-extracted message on redelivery', async () => {
		const session = await insertSession()
		const latest = await insertAssistantMessage(session.id, true, 3000n)

		await expect(
			runExtractionThenAutoAdvanceJob(
				db,
				{ sessionId: session.id, organizationId, userId, eventId: latest.id },
				runtime,
			),
		).resolves.toBe('ran')
		const [row] = await db
			.select({ suggestion: sessions.next_step_suggestions })
			.from(sessions)
			.where(eq(sessions.id, session.id))
		// Extraction (which would write the session-level suggestion) did not run again.
		expect(row?.suggestion ?? []).toEqual([])
	})
})
