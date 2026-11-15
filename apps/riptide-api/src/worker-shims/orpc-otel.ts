/** Worker-build replacement for `@orpc/otel`: OpenTelemetry instrumentation is not used on Workers. */
export class ORPCInstrumentation {
	constructor(_config?: unknown) {}
}
