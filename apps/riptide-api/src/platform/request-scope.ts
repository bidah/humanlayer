import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request scope for the Cloudflare Worker entry (`src/worker.ts`).
 *
 * Workers forbid sharing I/O objects (sockets, streams) between requests and cancel any work
 * still running after the response unless it is registered with `ctx.waitUntil`. The scope holds
 * what must be request-local (the Postgres client) and is the single seam background work goes
 * through. On Node there is never a scope: every helper here degrades to a no-op, so the AWS path
 * keeps its existing fire-and-forget semantics.
 */
export interface RequestScope {
	/** Lazily-created request-local resources keyed by owner (e.g. the database module). */
	readonly resources: Map<string, unknown>
	/** Cleanup callbacks run after the response and all background work have settled. */
	readonly cleanups: Array<() => Promise<void> | void>
	/** Background promises still running for this request. */
	readonly pending: Set<Promise<unknown>>
	/** The runtime's waitUntil (keeps the request alive after the response, ~30 s cap). */
	readonly waitUntil: (promise: Promise<unknown>) => void
}

const storage = new AsyncLocalStorage<RequestScope>()

export function getRequestScope(): RequestScope | undefined {
	return storage.getStore()
}

export function runWithRequestScope<T>(scope: RequestScope, fn: () => T): T {
	return storage.run(scope, fn)
}

export function makeRequestScope(waitUntil: (promise: Promise<unknown>) => void): RequestScope {
	return { resources: new Map(), cleanups: [], pending: new Set(), waitUntil }
}

/**
 * Register work that continues after the response (fire-and-forget). On Workers it is tracked by
 * the current request scope and handed to `waitUntil`; with no scope (Node) it is left running
 * exactly as before. Rejections are swallowed here — callers own their own error reporting.
 */
export function trackBackground<T>(promise: Promise<T>): Promise<T> {
	const scope = storage.getStore()
	if (!scope) return promise
	const tracked = promise.then(
		() => undefined,
		() => undefined,
	)
	scope.pending.add(tracked)
	void tracked.finally(() => scope.pending.delete(tracked))
	scope.waitUntil(tracked)
	return promise
}

/** Something with Effect's `Fiber.addObserver`, without importing Effect here. */
interface ObservableFiber {
	addObserver(cb: (exit: unknown) => void): unknown
}

/** Track a detached Effect fiber like {@link trackBackground}. Returns the fiber unchanged. */
export function trackBackgroundFiber<F extends ObservableFiber>(fiber: F): F {
	if (!storage.getStore()) return fiber
	void trackBackground(new Promise<void>((resolve) => fiber.addObserver(() => resolve())))
	return fiber
}

/** Resolves once every tracked background task (including ones added while waiting) has settled. */
export async function drainBackground(scope: RequestScope): Promise<void> {
	while (scope.pending.size > 0) {
		await Promise.allSettled([...scope.pending])
	}
}

export async function runCleanups(scope: RequestScope): Promise<void> {
	const cleanups = scope.cleanups.splice(0)
	await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()))
}
