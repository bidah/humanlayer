import { NodeCrypto } from '@effect/platform-node'
import { BillingKvService, BillingKvServiceLive } from '@humanlayer/billing/billing-kv'
import { makeRedisLive, RedisService } from '@humanlayer/billing/redis'
import type { RedisInitializationError } from '@humanlayer/billing/redis'
import { makeRedisKvLive } from '@humanlayer/billing/redis-kv'
import * as EffectSentry from '@sentry/effect/server'
import { Config, Crypto, Effect, ManagedRuntime } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import type { HttpClient } from 'effect/http/HttpClient'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Tracer from 'effect/Tracer'

import { db, dbReadReplica } from '../db/db'
import { isBillingOffInEnvironment } from '../lib/billing-mode'
import { trackBackgroundFiber } from '../platform/request-scope'
import { getOptionalWorkerEnv } from '../platform/worker-env'
import { WorkosServiceLive } from '../workos'
import { optionalIntegration } from './optional-integration'
import { type AccessRequestService, AccessRequestServiceLive } from './services/access-request/access-request.service'
import type { ArtifactComments } from './services/artifact-comments/artifact-comments'
import { ArtifactCommentsLive } from './services/artifact-comments/artifact-comments-live'
import { BillingCheckoutCompletionServiceLive } from './services/billing-checkout-completion/billing-checkout-completion.live'
import { BillingCheckoutCompletionService } from './services/billing-checkout-completion/billing-checkout-completion.service'
import { BillingAccessLive } from './services/billing/billing-access-service-live'
import type { BillingAccess } from './services/billing/billing-access.service'
import { type Entitlements, EntitlementsLive } from './services/billing/entitlements.service'
import {
	type CloudHostProvisioner,
	CloudHostProvisionerLive,
} from './services/cloud-hosts/cloud-host-provisioner.service'
import type { DiffComments } from './services/diff-comments/diff-comments'
import { DiffCommentsLive } from './services/diff-comments/diff-comments-live'
import {
	type DurableStreamsConfig,
	DurableStreamsConfigLive,
} from './services/durable-streams/durable-streams-config.service'
import { type DurableStreamSessionService, DurableStreamSessionServiceLive } from './services/durable-streams/streams'
import {
	type ExperimentAnalyticsService,
	ExperimentAnalyticsServiceLive,
} from './services/experiment-analytics/experiment-analytics.service'
import { GitHubService, GitHubServiceLive } from './services/github/github.service'
import { type PersonSpendAnalytics, PersonSpendAnalyticsLive } from './services/metrics/person-spend-analytics.service'
import { OnboardingService, OnboardingServiceLive } from './services/onboarding/onboarding.service'
import { type PostgresDb, PostgresDbLive } from './services/postgres/postgres-db.service'
import {
	type PostgresReadReplicaDb,
	PostgresReadReplicaDbLive,
} from './services/postgres/postgres-read-replica.service'
import { PrStatusStreamLive } from './services/pr-status-stream/pr-status-stream.layer'
import type { PrStatusStream } from './services/pr-status-stream/pr-status-stream.service'
import { ResendConfig, ResendConfigLive } from './services/resend/resend-config.service'
import { ResendHttpClient } from './services/resend/resend-http-client.service'
import { ResendServiceWithFetchHttpClientLive } from './services/resend/resend-service-live'
import { ResendService } from './services/resend/resend.service'
import { type S3, S3Live } from './services/s3/s3.service'
import {
	type SessionTitleGeneration,
	SessionTitleGenerationLive,
} from './services/session-title-generation/session-title-generation.service'
import { SlackService, SlackServiceLive } from './services/slack/slack.service'
import { StripeHttpClient } from './services/stripe/stripe-http-client.service'
import { StripeServiceWithFetchHttpClientLive } from './services/stripe/stripe-service-live'
import { StripeService } from './services/stripe/stripe.service'
import {
	type TaskDiffService,
	TaskDiffServiceLive,
} from './services/task-diff-durable-streams/task-diff-durable-streams.service'
import {
	type TaskIntentClassifier,
	TaskIntentClassifierLive,
} from './services/task-intent-classifier/task-intent-classifier.service'
import { TaskLaunchServiceLive } from './services/task-launch/task-launch.live'
import type { TaskLaunchService } from './services/task-launch/task-launch.service'
import type { WorkosService } from './services/workos/workos.service'
import { WorkspaceSetupServiceLive } from './services/workspace-setup/workspace-setup.live'
import { WorkspaceSetupPersistenceLive } from './services/workspace-setup/workspace-setup.persistence'
import type { WorkspaceSetupService } from './services/workspace-setup/workspace-setup.service'

/**
 * Type of all the services the app runtime will need
 */
export type AppRuntimeServices =
	| HttpClient
	| PostgresDb
	| Crypto.Crypto
	| PostgresReadReplicaDb
	| PersonSpendAnalytics
	| S3
	| WorkosService
	| ResendConfig
	| ResendService
	| AccessRequestService
	| DurableStreamsConfig
	| DurableStreamSessionService
	| TaskDiffService
	| OnboardingService
	| SlackService
	| WorkspaceSetupService
	| GitHubService
	| StripeService
	| StripeHttpClient
	| BillingAccess
	| Entitlements
	| BillingCheckoutCompletionService
	| BillingKvService
	| RedisService
	| ExperimentAnalyticsService
	| DiffComments
	| ArtifactComments
	| TaskLaunchService
	| TaskIntentClassifier
	| PrStatusStream
	| SessionTitleGeneration
	| CloudHostProvisioner

/**
 * The type for the actual runtime
 */
export type AppRuntimeInitializationError = Config.ConfigError | RedisInitializationError

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppRuntimeServices, AppRuntimeInitializationError>

export type BillingKvRuntime = ManagedRuntime.ManagedRuntime<
	BillingKvService | RedisService,
	AppRuntimeInitializationError
>

const isLocal = (process.env.SENTRY_ENVIRONMENT ?? 'local') === 'local'

export const EffectTracingLive = isLocal ? Layer.empty : Layer.succeed(Tracer.Tracer, EffectSentry.SentryEffectTracer)

const denseJsonConsoleLogger = Logger.withConsoleLog(Logger.formatJson)

const EffectLoggerLive = Logger.layer(
	isLocal ? [denseJsonConsoleLogger] : [denseJsonConsoleLogger, EffectSentry.SentryEffectLogger],
)

/**
 * Sentry observability for Effect spans, logs, and metrics.
 */
export const SentryEffectLive = Layer.mergeAll(
	EffectTracingLive,
	EffectLoggerLive,
	EffectSentry.SentryEffectMetricsLayer,
)

/**
 * Billing cache transport: Workers KV when the Worker's BILLING_KV binding is present (Cloudflare),
 * otherwise ioredis via KV_URL (Node/AWS). Chosen when the runtime is built, not at import.
 */
const RedisLive = Layer.unwrap(
	Effect.sync(() => {
		const kv = getOptionalWorkerEnv()?.BILLING_KV
		return kv ? makeRedisKvLive(kv) : makeRedisLive()
	}),
).pipe(Layer.provide(SentryEffectLive))

const BillingKvLive = BillingKvServiceLive.pipe(Layer.provideMerge(RedisLive))

/**
 * The live app runtime layer tree.
 */
const BaseRuntimeLive = Layer.mergeAll(
	NodeCrypto.layer,
	SentryEffectLive,
	PostgresDbLive(db),
	PostgresReadReplicaDbLive(dbReadReplica),
	S3Live,
	BillingKvLive,
	DurableStreamsConfigLive.pipe(Layer.orDie),
	optionalIntegration('Resend', ResendConfigLive, [ResendConfig]),
)
	// The one fetch transport, provided once. GitHub operations declare HttpClient in R and receive
	// this instance ambiently. Other services still wire their own transport; #2415 removes those.
	.pipe(Layer.provideMerge(FetchHttpClient.layer))

const CoreServiceLive = Layer.mergeAll(
	WorkosServiceLive,
	optionalIntegration('Resend', ResendServiceWithFetchHttpClientLive, [ResendService, ResendHttpClient]),
	DurableStreamSessionServiceLive,
	TaskDiffServiceLive.pipe(Layer.provide(FetchHttpClient.layer), Layer.orDie),
	optionalIntegration('Slack', SlackServiceLive.pipe(Layer.orDie), [SlackService]),
	WorkspaceSetupServiceLive.pipe(Layer.provide(WorkspaceSetupPersistenceLive)),
	optionalIntegration('GitHub', GitHubServiceLive.pipe(Layer.orDie), [GitHubService]),
	optionalIntegration(
		'Stripe',
		StripeServiceWithFetchHttpClientLive.pipe(Layer.orDie),
		[StripeService, StripeHttpClient],
		{ disabled: isBillingOffInEnvironment },
	),
	// Reads DURABLE_STREAMS_ORIGIN through DurableStreamsConfig, provided by BaseRuntimeLive below.
	PrStatusStreamLive,
).pipe(Layer.provideMerge(BaseRuntimeLive))

const OnboardingServiceWithDependenciesLive = optionalIntegration(
	'Onboarding (Resend)',
	OnboardingServiceLive.pipe(Layer.provide(CoreServiceLive)),
	[OnboardingService],
)

const CommentServicesLive = Layer.mergeAll(DiffCommentsLive, ArtifactCommentsLive).pipe(
	Layer.provide(Layer.mergeAll(CoreServiceLive, OnboardingServiceWithDependenciesLive)),
)

export const AppRuntimeLive = Layer.mergeAll(
	AccessRequestServiceLive,
	BillingAccessLive,
	EntitlementsLive,
	PersonSpendAnalyticsLive,
	OnboardingServiceWithDependenciesLive,
	optionalIntegration(
		'Stripe checkout completion',
		BillingCheckoutCompletionServiceLive.pipe(Layer.orDie),
		[BillingCheckoutCompletionService],
		{ disabled: isBillingOffInEnvironment },
	),
	ExperimentAnalyticsServiceLive.pipe(Layer.orDie),
	TaskLaunchServiceLive,
	TaskIntentClassifierLive,
	SessionTitleGenerationLive,
	CloudHostProvisionerLive,
	CommentServicesLive,
).pipe(Layer.provideMerge(CoreServiceLive))

/**
 * The managed runtime used by Effect oRPC procedures.
 */
export const appRuntime: AppRuntime = trackDetachedRunFork(ManagedRuntime.make(AppRuntimeLive))

/**
 * `runFork` is how request handlers start fire-and-forget work (webhooks that 202 then continue,
 * title generation, auto-advance...). On Cloudflare Workers that work is cancelled once the response
 * is sent unless it is registered with the request's `waitUntil`; this routes every such fiber
 * through the request-scope seam. Outside a Worker request scope it is a no-op.
 */
function trackDetachedRunFork(runtime: AppRuntime): AppRuntime {
	const runFork = runtime.runFork.bind(runtime)
	const tracked: AppRuntime['runFork'] = (effect, options) => trackBackgroundFiber(runFork(effect, options))
	// ManagedRuntime.make returns a plain object whose methods close over it, so replacing the
	// property is enough (the type marks it readonly).
	;(runtime as { runFork: AppRuntime['runFork'] }).runFork = tracked
	return runtime
}
