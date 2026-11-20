import { trackBackground } from './request-scope'
import { getOptionalWorkerEnv } from './worker-env'

/**
 * Seam for post-response work that can outlive `ctx.waitUntil` (~30 s after the response on
 * Cloudflare Workers): LLM calls, delayed refreshes.
 *
 * Each such task is a named job with a small JSON payload of ids (never objects: the consumer
 * re-reads current state, which is also what makes redelivery safe). On Workers with the
 * `BACKGROUND_QUEUE` binding the job is sent to the `human-flare-background` Cloudflare Queue and
 * run by the `queue()` handler of the same Worker (src/jobs/consumer.ts). Everywhere else (Node/AWS,
 * tests, a Worker without the binding) the caller's `inProcess` function runs exactly as before,
 * so the Node path is unchanged.
 *
 * Payload types live here (not next to the handlers) so producers stay free of consumer imports.
 */
export interface BackgroundJobPayloads {
	/** AI title for an untitled session, generated from its stored prompt. */
	readonly 'session.generate-title': {
		readonly sessionId: string
		readonly organizationId: string
		readonly userId: string
	}
	/** Next-step extraction from the session's last assistant message, then auto-advance. */
	readonly 'session.extract-next-step-then-auto-advance': {
		readonly sessionId: string
		readonly organizationId: string
		readonly userId: string
		/** The last root assistant message when the session reached ready_for_input; null if none. */
		readonly eventId: string | null
	}
	/** Re-read a pull request's merge state from GitHub after its check burst settles. */
	readonly 'github.refresh-merge-state': {
		readonly installationId: string
		readonly repoFullName: string
		readonly branch: string
	}
	/** Operational probe: logs and succeeds, or fails every attempt (exercises retries and the DLQ). */
	readonly 'ops.probe': {
		readonly note: string
		readonly fail?: boolean
	}
}

export type BackgroundJobName = keyof BackgroundJobPayloads

/** The queue message body. `v` versions the envelope for rolling deploys. */
export interface BackgroundJobMessage<N extends BackgroundJobName = BackgroundJobName> {
	readonly v: 1
	readonly job: N
	readonly payload: BackgroundJobPayloads[N]
	readonly enqueuedAt: number
}

/** Structural type of a Cloudflare Queue producer binding. */
export interface QueueProducerBinding {
	send(body: unknown, options?: { contentType?: 'json'; delaySeconds?: number }): Promise<unknown>
}

/** Cloudflare caps per-message delivery delay at 24 h. */
const MAX_DELAY_SECONDS = 86_400

function getQueue(): QueueProducerBinding | undefined {
	return getOptionalWorkerEnv()?.BACKGROUND_QUEUE
}

/** Whether jobs are currently routed to the Cloudflare Queue (Workers with the binding). */
export function backgroundQueueEnabled(): boolean {
	return getQueue() !== undefined
}

/**
 * Dispatch a background job. With the queue: send it (delayed by `delaySeconds`), keeping the
 * request alive only for the send itself. Without: run `inProcess` (today's behaviour, unchanged).
 *
 * Fire-and-forget like the call sites it replaces: the returned promise settles when the job was
 * handed off (or the in-process work finished) and never rejects; failures are logged.
 */
export function dispatchBackgroundJob<N extends BackgroundJobName>(
	job: N,
	payload: BackgroundJobPayloads[N],
	options: { readonly delaySeconds?: number; readonly inProcess: () => unknown },
): Promise<void> {
	const queue = getQueue()
	if (!queue) {
		// Today's behaviour. On a Worker without the binding this still goes through waitUntil.
		return trackBackground(
			Promise.resolve()
				.then(options.inProcess)
				.then(
					() => undefined,
					() => undefined,
				),
		)
	}
	const message: BackgroundJobMessage<N> = { v: 1, job, payload, enqueuedAt: Date.now() }
	const delaySeconds = clampDelay(options.delaySeconds)
	const sendOptions: { contentType: 'json'; delaySeconds?: number } = { contentType: 'json' }
	if (delaySeconds) sendOptions.delaySeconds = delaySeconds
	const sent = queue.send(message, sendOptions).then(
		() => {
			console.log(JSON.stringify({ message: 'Background job enqueued', job, delaySeconds: delaySeconds ?? 0 }))
		},
		(error: unknown) => {
			console.error(
				JSON.stringify({
					message: 'Background job enqueue failed',
					job,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		},
	)
	return trackBackground(sent)
}

function clampDelay(delaySeconds: number | undefined): number | undefined {
	if (delaySeconds === undefined || !Number.isFinite(delaySeconds) || delaySeconds <= 0) return undefined
	return Math.min(Math.ceil(delaySeconds), MAX_DELAY_SECONDS)
}
