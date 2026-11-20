import logger from '../logger'
import { drainBackground, makeRequestScope, runCleanups, runWithRequestScope } from '../platform/request-scope'
import { runBackgroundJob } from './registry'

/** Structural types for the Cloudflare Queue consumer API (no workers-types globals). */
export interface QueueMessageLike {
	readonly id: string
	readonly body: unknown
	readonly attempts: number
	ack(): void
	retry(options?: { delaySeconds?: number }): void
}

export interface MessageBatchLike {
	readonly queue: string
	readonly messages: ReadonlyArray<QueueMessageLike>
}

/** Backoff for failed attempts: 10 s, 30 s, 90 s, ... capped at 15 minutes. */
export function retryDelaySeconds(attempts: number): number {
	return Math.min(10 * 3 ** Math.max(0, attempts - 1), 900)
}

/**
 * `queue()` handler body for `human-flare-background`.
 *
 * Messages run one at a time, each inside its own request scope, exactly like a fetch: its own
 * request-local Postgres client (Hyperdrive), background work registered with `waitUntil` and
 * drained, and the client closed afterwards. Sequential processing keeps every invocation under
 * the per-invocation connection limit. Each message is acked or retried individually, so one
 * failure never replays its siblings; after `max_retries` the queue moves it to the DLQ.
 */
export async function handleBackgroundQueueBatch(
	batch: MessageBatchLike,
	waitUntil: (promise: Promise<unknown>) => void,
	run: (body: unknown) => Promise<{ result: unknown }> = runBackgroundJob,
): Promise<void> {
	for (const message of batch.messages) {
		const scope = makeRequestScope(waitUntil)
		const startedAt = Date.now()
		const job = (message.body as { job?: unknown } | null)?.job
		try {
			const { result } = await runWithRequestScope(scope, () => run(message.body))
			message.ack()
			logger.info(
				{
					queue: batch.queue,
					messageId: message.id,
					job,
					attempts: message.attempts,
					result,
					ms: Date.now() - startedAt,
				},
				'Background job succeeded',
			)
		} catch (error) {
			const delaySeconds = retryDelaySeconds(message.attempts)
			message.retry({ delaySeconds })
			logger.error(
				{
					queue: batch.queue,
					messageId: message.id,
					job,
					attempts: message.attempts,
					retryInSeconds: delaySeconds,
					error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
				},
				'Background job failed; retrying (dead-lettered after max_retries)',
			)
		} finally {
			await runWithRequestScope(scope, async () => {
				await drainBackground(scope)
				await runCleanups(scope)
			})
		}
	}
}
