/**
 * Worker-build replacement for `@sentry/node` and `@sentry/core` (wired via `alias` in
 * wrangler.jsonc; the Node build is unaffected).
 *
 * `@sentry/node` cannot run on workerd (OpenTelemetry/Node instrumentation, timers started in
 * global scope by `Sentry.init`), and the ~110 import sites only use a small capture/scope surface.
 * This shim keeps those call sites compiling and running: captures are written to the console as
 * structured JSON so they show up in Workers Logs (observability), and everything else is a no-op.
 * Swap for `@sentry/cloudflare` once a DSN exists for this deployment.
 */

type Tags = Record<string, unknown>
interface CaptureContext {
	tags?: Tags
	extra?: Record<string, unknown>
	level?: string
	[key: string]: unknown
}

const describe = (error: unknown) =>
	error instanceof Error
		? { name: error.name, message: error.message, stack: error.stack }
		: { message: typeof error === 'string' ? error : safeJson(error) }

const safeJson = (value: unknown) => {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

export function captureException(error: unknown, context?: CaptureContext | ((scope: unknown) => unknown)): string {
	const tags = typeof context === 'object' ? context?.tags : undefined
	console.error(JSON.stringify({ sentry: 'exception', error: describe(error), tags }))
	return ''
}

export function captureMessage(message: string, context?: CaptureContext | string): string {
	const level = typeof context === 'string' ? context : context?.level
	const tags = typeof context === 'object' ? context?.tags : undefined
	console.warn(JSON.stringify({ sentry: 'message', message, level, tags }))
	return ''
}

export const setTag = (_key: string, _value: unknown): void => {}
export const setTags = (_tags: Tags): void => {}
export const setUser = (_user: unknown): void => {}
export const setContext = (_name: string, _context: unknown): void => {}
export const setExtra = (_key: string, _value: unknown): void => {}
export const addBreadcrumb = (_breadcrumb: unknown): void => {}
export const init = (_options?: unknown): undefined => undefined
export const flush = async (_timeout?: number): Promise<boolean> => true
export const close = async (_timeout?: number): Promise<boolean> => true
export const isInitialized = (): boolean => false
export const getActiveSpan = (): undefined => undefined
export const getRootSpan = (span: unknown): unknown => span

const noopScope = {
	setTag,
	setTags,
	setUser,
	setContext,
	setExtra,
	setLevel: (_level: unknown) => {},
	setFingerprint: (_fingerprint: unknown) => {},
	addBreadcrumb,
	captureException,
	captureMessage,
}
export const getCurrentScope = () => noopScope
export const getIsolationScope = () => noopScope
export function withScope<T>(callback: (scope: typeof noopScope) => T): T {
	return callback(noopScope)
}
export function startSpan<T>(_options: unknown, callback: (span: undefined) => T): T {
	return callback(undefined)
}

const integration = (name: string) => () => ({ name })
export const honoIntegration = integration('Hono')
export const zodErrorsIntegration = integration('ZodErrors')
export const extraErrorDataIntegration = integration('ExtraErrorData')

/** `@sentry/core` export used by src/db/db.ts (Node path only, but must resolve). */
export const instrumentPostgresJsSql = <T>(sql: T, _options?: unknown): T => sql

export type ErrorEvent = Record<string, unknown>
