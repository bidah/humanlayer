import { Effect } from 'effect'
import z from 'zod/v4'

import { db } from '../db/db'
import { appRuntime } from '../effects/app-runtime'
import { GitHubService } from '../effects/services/github/github.service'
import { generateSessionTitleFromStoredPrompt } from '../lib/session-title-generation'
import logger from '../logger'
import { runExtractionThenAutoAdvanceJob } from '../orpc/daemon/sessions/update'
import type { BackgroundJobName, BackgroundJobPayloads } from '../platform/background-jobs'

/**
 * Background job registry: job name → payload schema → handler. The Cloudflare Queue consumer
 * (jobs/consumer.ts) dispatches every message through here; producers go through
 * platform/background-jobs.ts. Handlers re-read current state before acting (delivery is
 * at-least-once) and throw on failures worth retrying.
 */
interface JobDefinition<N extends BackgroundJobName> {
	readonly payload: z.ZodType<BackgroundJobPayloads[N]>
	readonly run: (payload: BackgroundJobPayloads[N]) => Promise<unknown>
}

const id = z.string().min(1)

export const backgroundJobs: { readonly [N in BackgroundJobName]: JobDefinition<N> } = {
	'session.generate-title': {
		payload: z.object({ sessionId: id, organizationId: id, userId: id }),
		run: (payload) => generateSessionTitleFromStoredPrompt(db, payload),
	},
	'session.extract-next-step-then-auto-advance': {
		payload: z.object({ sessionId: id, organizationId: id, userId: id, eventId: id.nullable() }),
		run: (payload) => runExtractionThenAutoAdvanceJob(db, payload, appRuntime),
	},
	'github.refresh-merge-state': {
		payload: z.object({ installationId: id, repoFullName: id, branch: id }),
		// The same refresh a `pull_request_review` delivery triggers: re-read the pull request from
		// GitHub and upsert it. Idempotent; failures are captured to Sentry inside handleWebhook.
		run: (payload) =>
			appRuntime.runPromise(
				Effect.gen(function* () {
					const github = yield* GitHubService
					yield* github.handleWebhook({ type: 'pr_reviewed', ...payload, deliveryId: null })
				}),
			),
	},
	'ops.probe': {
		payload: z.object({ note: z.string(), fail: z.boolean().optional() }),
		run: async (payload) => {
			if (payload.fail) throw new Error(`ops.probe failing on purpose: ${payload.note}`)
			logger.info({ note: payload.note }, 'ops.probe job ran')
		},
	},
}

export class UnknownBackgroundJobError extends Error {
	constructor(readonly job: unknown) {
		super(`Unknown background job: ${String(job)}`)
		this.name = 'UnknownBackgroundJobError'
	}
}

const envelope = z.object({ v: z.literal(1), job: z.string(), payload: z.unknown(), enqueuedAt: z.number() })

/** Validate a queue message body and run its job. Throws on invalid messages and job failures. */
export async function runBackgroundJob(body: unknown): Promise<{ job: BackgroundJobName; result: unknown }> {
	const message = envelope.parse(body)
	if (!Object.hasOwn(backgroundJobs, message.job)) throw new UnknownBackgroundJobError(message.job)
	const job = message.job as BackgroundJobName
	const definition = backgroundJobs[job] as JobDefinition<BackgroundJobName>
	const payload = definition.payload.parse(message.payload)
	return { job, result: await definition.run(payload) }
}
