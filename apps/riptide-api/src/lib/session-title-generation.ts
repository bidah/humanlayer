import { generateSessionTitle } from '@humanlayer/ai/generate-session-title'
import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { Sentry } from '../instrument'
import logger from '../logger'
import { dispatchBackgroundJob } from '../platform/background-jobs'
import { createRiptideReliableLanguageModel } from './reliable-language-model'

export interface SessionTitleGenerationParams {
	sessionId: string
	organizationId: string
	userId: string
	prompt: string
	ticketId: string | null
	taskName?: string | null
}

const pendingSessionTitleGenerations = new Set<Promise<void>>()

/**
 * Fire-and-forget AI session title generation. Callers invoke this after their
 * transaction commits, without awaiting it; failures are swallowed to Sentry
 * and never affect the calling procedure.
 */
export function runSessionTitleGenerationAsync(
	db: PostgresJsDatabase,
	{ sessionId, organizationId, userId, prompt, ticketId, taskName }: SessionTitleGenerationParams,
) {
	// Workers with the background queue: a `session.generate-title` job (the LLM call can outlive
	// waitUntil). Otherwise in process, as before (tracked by waitUntil on Workers; no-op on Node).
	const generation = dispatchBackgroundJob(
		'session.generate-title',
		{ sessionId, organizationId, userId },
		{
			inProcess: () =>
				generateAndPersistSessionTitle(db, {
					sessionId,
					organizationId,
					userId,
					prompt,
					ticketId,
					taskName,
				}),
		},
	)
	pendingSessionTitleGenerations.add(generation)
	void generation.finally(() => pendingSessionTitleGenerations.delete(generation))
	return generation
}

export async function waitForPendingSessionTitleGenerations(): Promise<void> {
	await Promise.all(pendingSessionTitleGenerations)
}

async function generateAndPersistSessionTitle(
	db: PostgresJsDatabase,
	{ sessionId, organizationId, userId, prompt, ticketId, taskName }: SessionTitleGenerationParams,
) {
	try {
		const title = await generateSessionTitle(prompt, ticketId, taskName, {
			model: createRiptideReliableLanguageModel('haiku'),
		})
		const [updatedSession] = await db
			.update(sessions)
			.set({ title })
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.organization_id, organizationId),
					eq(sessions.created_by, userId),
					isNull(sessions.title),
				),
			)
			.returning({ id: sessions.id })
		if (updatedSession) logger.info({ sessionId, title }, 'AI session title generated')
		else logger.debug({ sessionId }, 'AI session title was not applied because the session already has a title')
	} catch (err) {
		logger.error({ err, sessionId }, 'AI session title generation failed')
		Sentry.captureException(err, {
			tags: { error_type: 'ai_title_generation' },
			extra: { sessionId },
		})
	}
}

/**
 * Queue consumer for `session.generate-title` (src/jobs/registry.ts). Re-reads the session so a
 * redelivered or late job only acts if the session still exists and is still untitled, and lets
 * failures throw so the queue retries them (then dead-letters).
 */
export async function generateSessionTitleFromStoredPrompt(
	db: PostgresJsDatabase,
	{ sessionId, organizationId, userId }: { sessionId: string; organizationId: string; userId: string },
): Promise<'generated' | 'skipped'> {
	const [session] = await db
		.select({ title: sessions.title, prompt: sessions.prompt, ticketId: tasks.ticket_id, taskName: tasks.name })
		.from(sessions)
		.leftJoin(tasks, eq(tasks.id, sessions.task_id))
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.organization_id, organizationId),
				eq(sessions.created_by, userId),
			),
		)
		.limit(1)
	if (!session || session.title || !session.prompt?.trim()) {
		logger.debug({ sessionId }, 'AI session title job skipped (session missing, titled, or without prompt)')
		return 'skipped'
	}

	const title = await generateSessionTitle(session.prompt, session.ticketId ?? null, session.taskName, {
		model: createRiptideReliableLanguageModel('haiku'),
	})
	const [updated] = await db
		.update(sessions)
		.set({ title })
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.organization_id, organizationId),
				eq(sessions.created_by, userId),
				isNull(sessions.title),
			),
		)
		.returning({ id: sessions.id })
	if (updated) logger.info({ sessionId, title }, 'AI session title generated')
	return updated ? 'generated' : 'skipped'
}
