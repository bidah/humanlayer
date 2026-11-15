/**
 * Worker-build replacement for `@sentry/effect/server` (see ./sentry.ts). Provides inert
 * tracer/logger/metrics so the Effect runtime layers compose unchanged.
 */
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Tracer from 'effect/Tracer'

export const SentryEffectTracer = Tracer.nativeTracer
export const SentryEffectLogger = Logger.make(() => {})
export const SentryEffectMetricsLayer = Layer.empty
