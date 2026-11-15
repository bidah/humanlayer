/**
 * No-op stand-in for `@sentry/node`, `@sentry/core` and `@sentry/effect/server` in the Cloudflare
 * Worker build. Those SDKs are Node-only (OpenTelemetry, diagnostics_channel, process hooks), so
 * `wrangler.jsonc` aliases all three to this module. Every Sentry call site in the proxy keeps
 * compiling and running; the calls just do nothing. Errors still reach Workers Logs through the
 * existing logger calls next to each capture.
 *
 * Only the members the proxy actually uses are provided. If a new Sentry import is added and the
 * Worker bundle fails with "No matching export", add a no-op for it here.
 */
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Tracer from 'effect/Tracer'

type Scope = {
	setUser: (user: unknown) => void
	setTag: (key: string, value: unknown) => void
	setContext: (key: string, value: unknown) => void
	setExtra: (key: string, value: unknown) => void
	setLevel: (level: unknown) => void
}

const noopScope: Scope = {
	setUser: () => {},
	setTag: () => {},
	setContext: () => {},
	setExtra: () => {},
	setLevel: () => {},
}

export const captureException = (_error: unknown, _hint?: unknown): string => ''
export const captureMessage = (_message: string, _hint?: unknown): string => ''
export const addBreadcrumb = (_breadcrumb: unknown): void => {}
export const setUser = (_user: unknown): void => {}
export const setTag = (_key: string, _value: unknown): void => {}
export const setContext = (_key: string, _value: unknown): void => {}
export const withScope = <T>(callback: (scope: Scope) => T): T => callback(noopScope)
export const flush = async (_timeout?: number): Promise<boolean> => true
export const close = async (_timeout?: number): Promise<boolean> => true

// @sentry/node integrations referenced by sentry.service.ts at module load.
const noopIntegration = (name: string) => () => ({ name, setupOnce: () => {} })
export const honoIntegration = noopIntegration('Hono')
export const zodErrorsIntegration = noopIntegration('ZodErrors')
export const extraErrorDataIntegration = noopIntegration('ExtraErrorData')

// @sentry/core helper used by lib/db.ts (not loaded by the Worker, kept for completeness).
export const instrumentPostgresJsSql = <T>(sql: T, _options?: unknown): T => sql

// @sentry/effect/server surface used by sentry.service.ts. The Worker runtime never provides
// SentryLive, but sentry.service.ts builds these values at import time, so they must exist.
export const effectLayer = (_options?: unknown) => Layer.empty
export const SentryEffectTracer = Tracer.make({
	span: (() => {
		throw new Error('Sentry tracer shim is not usable in the Worker build')
	}) as never,
})
export const SentryEffectLogger = Logger.make(() => {})
export const SentryEffectMetricsLayer = Layer.empty
