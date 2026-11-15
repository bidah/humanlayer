import { sessions } from '@humanlayer/db/tables/sessions'
import { tasks } from '@humanlayer/db/tables/tasks'
import * as Sentry from '@sentry/node'
import { Effect } from 'effect'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Resend } from 'resend'
import Stripe from 'stripe'

import { getAuthContext, getDaemonAuthContext } from './auth/context'
import { jwksCache } from './auth/jwks-cache'
import { db, dbReadReplica } from './db/db'
import { appRuntime } from './effects/app-runtime'
import { AccessRequestService } from './effects/services/access-request/access-request.service'
import { createBillingDisabledStripeService, isBillingDisabled, isStripeConfigured } from './lib/billing-mode'
import {
	getResendApiKey,
	getResendWebhookSecret,
	getStripePricePro,
	getStripePriceStarter,
	getStripeSecretKey,
	getStripeWebhookSecret,
} from './lib/environment'
import { getJiraClientId, getJiraClientSecret, getJiraOAuthRedirectUrl } from './lib/jira'
import { JiraService } from './lib/jira-service'
import { lazyInstance } from './lib/lazy-instance'
import { getLinearClientId, getLinearClientSecret, getLinearOAuthRedirectUrl } from './lib/linear'
import { LinearService } from './lib/linear-service'
import { createObjectStorage } from './lib/object-storage'
import { requestBodyLimit } from './lib/request-body-limit'
import { StripeService } from './lib/stripe-service'
import { logger } from './logger'
import { apiHandler, daemonApiHandler } from './orpc'
import { isCloudflareWorker } from './platform/runtime'
import { getOptionalWorkerEnv } from './platform/worker-env'
import { registerBillingCheckoutCompletionRoutes } from './routes/billing-checkout-completion'
import { registerR2ObjectStorageRoutes } from './routes/r2-object-storage'
import { registerGitHubSetupCallbackRoute, registerGitHubWebhookRoute } from './webhooks/github'
import { registerJiraOAuthCallbackRoute } from './webhooks/jira'
import { registerLinearOAuthCallbackRoute } from './webhooks/linear'
import { registerResendWebhookRoute } from './webhooks/resend'
import { registerSlackInteractionsRoute, registerSlackOAuthCallbackRoute } from './webhooks/slack'
import { registerStripeWebhookRoute } from './webhooks/stripe'
import { registerWorkosWebhookRoute } from './webhooks/workos'
import { workosSdkAdapter } from './workos'

const app = new Hono()

// Body size limit - MUST be before other middleware to prevent OOM from large payloads
app.use('*', requestBodyLimit)

// Global error handler - catches unhandled errors before returning 500
app.onError((err, c) => {
	Sentry.captureException(err)
	logger.error(err, 'Unhandled error in request')
	return c.json({ error: 'Internal Server Error' }, 500)
})

// On Cloudflare Workers module scope must not perform I/O (no endless refresh loop: the JWT
// validator refreshes the JWKS on a key miss) and the Worker must boot with optional integrations
// unconfigured, so integration clients are built on first use there. Node keeps the eager,
// fail-fast construction below.
const onWorkers = isCloudflareWorker()
const eager = { eager: !onWorkers }

// Start JWKS cache refresh loop
if (!onWorkers) void jwksCache.start()

// Create service instances at startup (singletons per process)
const s3Service = lazyInstance(() => createObjectStorage(), eager)

const jiraService = lazyInstance(
	() => new JiraService(getJiraClientId(), getJiraClientSecret(), db, getJiraOAuthRedirectUrl()),
	eager,
)
const linearService = lazyInstance(
	() => new LinearService(getLinearClientId(), getLinearClientSecret(), db, getLinearOAuthRedirectUrl()),
	eager,
)
// Without STRIPE_SECRET_KEY the deployment runs with billing off (see lib/billing-mode.ts).
const stripeService = isStripeConfigured()
	? lazyInstance(
			() =>
				new StripeService(new Stripe(getStripeSecretKey()), getStripeWebhookSecret(), {
					billingKvRuntime: appRuntime,
					starterPriceId: getStripePriceStarter(),
					proPriceId: getStripePricePro(),
				}),
			eager,
		)
	: createBillingDisabledStripeService()
const billingDisabled = () => isBillingDisabled(stripeService)
const resend = lazyInstance(() => new Resend(getResendApiKey()), eager)
/**
 * App-runtime-backed facade for the WorkOS webhook's access-request backfill. The
 * webhook is not an oRPC procedure, so it can't bind to `appRuntime` the way Effect
 * procedures do; instead we run `AccessRequestService.backfillRequesterUserId` through
 * the shared production `appRuntime` (built with the live db). `backfillRequesterUserId`
 * already maps its failures to `AccessRequestUnavailableError`, and the webhook wraps
 * this call in its own best-effort try/catch.
 */
async function backfillAccessRequestRequesterUserId(input: { email: string; userId: string }): Promise<void> {
	await appRuntime.runPromise(
		Effect.gen(function* () {
			const accessRequests = yield* AccessRequestService
			yield* accessRequests.backfillRequesterUserId(input)
		}),
	)
}

function getRequestIp(req: Request): string | undefined {
	const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
	return forwardedFor || req.headers.get('cf-connecting-ip') || undefined
}

// Enable CORS
app.use('*', cors())

app.get('/', async (c) => {
	try {
		await db.select({ id: sessions.id }).from(sessions).limit(20)
		await db.select({ id: tasks.id }).from(tasks).limit(20)
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	} catch (err) {
		logger.error(err, 'Health check failed')
		return c.json({ status: 'unhealthy', error: String(err), timestamp: new Date().toISOString() }, 503)
	}
})

app.get('/health', async (c) => {
	try {
		await db.select({ id: sessions.id }).from(sessions).limit(20)
		await db.select({ id: tasks.id }).from(tasks).limit(20)
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	} catch (err) {
		logger.error(err, 'Health check failed')
		return c.json({ status: 'unhealthy', error: String(err), timestamp: new Date().toISOString() }, 503)
	}
})

registerStripeWebhookRoute(app, { appRuntime, billingDisabled })
registerWorkosWebhookRoute(app, {
	workosService: workosSdkAdapter,
	stripeService,
	db,
	backfillAccessRequestRequesterUserId,
})
// On Workers the secret is read per request so a missing value fails only this webhook, not boot.
registerResendWebhookRoute(
	app,
	onWorkers
		? {
				resend,
				get webhookSecret() {
					return getResendWebhookSecret()
				},
				logger,
			}
		: { resend, webhookSecret: getResendWebhookSecret(), logger },
)
registerR2ObjectStorageRoutes(app, { getBucket: () => getOptionalWorkerEnv()?.ARTIFACTS })
registerBillingCheckoutCompletionRoutes(app, { billingDisabled })
registerGitHubSetupCallbackRoute(app, { appRuntime, logger })
registerGitHubWebhookRoute(app, { appRuntime, logger })
registerJiraOAuthCallbackRoute(app, { jiraService, appRuntime, logger })
registerLinearOAuthCallbackRoute(app, { linearService, appRuntime, logger })
registerSlackOAuthCallbackRoute(app, { appRuntime, logger })
registerSlackInteractionsRoute(app, { appRuntime, logger })

// mount oRPC handler
app.use('/rpc/api/v1/*', async (c, next) => {
	// Get the auth context
	// Extract Authorization header
	let authContext
	try {
		authContext = await getAuthContext(c.req.raw, appRuntime)
	} catch {
		return c.json({ error: 'Authentication unavailable' }, 503)
	}

	if (authContext) {
		Sentry.setUser({ id: authContext.userId })
		Sentry.setTag('organization_id', authContext.organizationId)
	}

	// Rename transaction from generic "POST /rpc/api/v1/*" to the oRPC procedure path
	const procedurePath = new URL(c.req.url).pathname.replace('/rpc/api/v1/', '')
	const activeSpan = Sentry.getActiveSpan()
	const rootSpan = activeSpan ? Sentry.getRootSpan(activeSpan) : undefined
	if (rootSpan && procedurePath) {
		rootSpan.updateName(`${c.req.method} /rpc/api/v1/${procedurePath}`)
	}

	const { matched, response } = await apiHandler.handle(c.req.raw, {
		prefix: '/rpc/api/v1',
		context: {
			auth: authContext,
			headers: c.req.raw.headers,
			requestIp: getRequestIp(c.req.raw),
			services: {
				workos: workosSdkAdapter,
				s3: s3Service,
				jira: jiraService,
				linear: linearService,
				stripe: stripeService,
				db,
				dbReadReplica,
				effectRuntime: appRuntime,
			},
		},
	})

	if (matched) {
		return c.newResponse(response.body, response)
	}

	await next()
})

app.use('/rpc/daemon/v1/*', async (c, next) => {
	// Get the auth context
	// Extract Authorization header
	const authContext = await getDaemonAuthContext(c.req.raw)

	if (authContext) {
		Sentry.setUser({ id: authContext.userId })
		Sentry.setTag('organization_id', authContext.organizationId)
	}

	// Rename transaction from generic "POST /rpc/daemon/v1/*" to the oRPC procedure path
	const procedurePath = new URL(c.req.url).pathname.replace('/rpc/daemon/v1/', '')
	const activeSpan = Sentry.getActiveSpan()
	const rootSpan = activeSpan ? Sentry.getRootSpan(activeSpan) : undefined
	if (rootSpan && procedurePath) {
		rootSpan.updateName(`${c.req.method} /rpc/daemon/v1/${procedurePath}`)
	}

	const { matched, response } = await daemonApiHandler.handle(c.req.raw, {
		prefix: '/rpc/daemon/v1',
		context: {
			auth: authContext,
			services: {
				workos: workosSdkAdapter,
				s3: s3Service,
				jira: jiraService,
				linear: linearService,
				stripe: stripeService,
				db,
				dbReadReplica,
				effectRuntime: appRuntime,
			},
		},
	})

	if (matched) {
		return c.newResponse(response.body, response)
	}

	await next()
})

export { app }
