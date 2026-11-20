/**
 * Cloudflare Workers entry for riptide-api (deployed as `human-flare-api`, see wrangler.jsonc).
 *
 * The Node entry (`src/index.ts`) is unchanged and still used for the AWS deployment. Differences
 * here:
 * - `process.env` is populated by workerd from vars/secrets before any module evaluates
 *   (`nodejs_compat` + compatibility date >= 2025-04-01), so `requireEnvironment` and Effect
 *   `Config` read Worker configuration unchanged.
 * - Each request runs inside a request scope (platform/request-scope.ts) that owns the
 *   request-local Postgres client (db/worker-db.ts) and collects background work, which is handed
 *   to `ctx.waitUntil`. The client is closed after the response and that work have settled.
 * - The Effect `ManagedRuntime` is built lazily on first use and reused for the isolate's lifetime;
 *   it holds no sockets of its own (the database is resolved per request).
 * - Durable Streams traffic is routed through the `STREAMS` service binding (platform/streams-fetch.ts).
 * - Post-response work that can outlive `waitUntil` is sent to the `human-flare-background` queue
 *   (platform/background-jobs.ts) and consumed by `queue()` below, one request scope per message.
 *
 * `./platform/worker-globals` must stay the first import and a bare side-effect import (import
 * sorting keeps those in place): it installs global patches before the app graph evaluates.
 */
import './platform/worker-globals'
import { app } from './app'
import { handleBackgroundQueueBatch, type MessageBatchLike } from './jobs/consumer'
import { drainBackground, makeRequestScope, runCleanups, runWithRequestScope } from './platform/request-scope'
import { restoreStackTraces } from './platform/startup-stack-traces'
import { type WorkerEnv, setWorkerEnv } from './platform/worker-env'

interface ExecutionContextLike {
	waitUntil(promise: Promise<unknown>): void
	passThroughOnException(): void
	readonly props: unknown
}

export default {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
		restoreStackTraces()
		setWorkerEnv(env)
		const scope = makeRequestScope((promise) => ctx.waitUntil(promise))
		try {
			return await runWithRequestScope(scope, () => app.fetch(request, env, ctx))
		} finally {
			// Close the request-local DB client only after every tracked background task settled.
			ctx.waitUntil(
				runWithRequestScope(scope, async () => {
					await drainBackground(scope)
					await runCleanups(scope)
				}),
			)
		}
	},

	async queue(batch: MessageBatchLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
		restoreStackTraces()
		setWorkerEnv(env)
		await handleBackgroundQueueBatch(batch, (promise) => ctx.waitUntil(promise))
	},
}
