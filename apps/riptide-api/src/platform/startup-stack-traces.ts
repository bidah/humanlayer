/**
 * Startup CPU budget (1 s on Workers): Effect captures a stack trace (`new Error()`) for every
 * `Effect.fn`/`withSpan` defined at module scope unless `Error.stackTraceLimit` is 0, which was the
 * single largest startup cost in the profile. The Worker disables it while the app graph evaluates
 * and restores it before handling the first request.
 */
let savedLimit: number | undefined

export function disableStackTracesDuringStartup(): void {
	savedLimit = Error.stackTraceLimit
	Error.stackTraceLimit = 0
}

export function restoreStackTraces(): void {
	if (savedLimit === undefined) return
	Error.stackTraceLimit = savedLimit
	savedLimit = undefined
}
