/**
 * The Hono app factory, free of Node-only imports so both the Node entry (index.ts via server.ts)
 * and the Cloudflare Worker entry (worker.ts) can use it. No side effects, no env vars.
 */

import { Effect } from 'effect'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'

import type { AppConfig, SimpleAuthContext } from './app-config'
import { ConnectionMetrics } from './lib/effect/connection-metrics.service'
import { attachGlobalErrorHandler } from './routes/error-handler'
import { createResponseEditorCollaborationApp } from './routes/response-editor-collaboration'
import { createStreamsApp } from './routes/streams'
import { createV1App } from './routes/v1'
import { createV2App } from './routes/v2'
import { createV3App } from './routes/v3'

export function createApp(config: AppConfig) {
	const app = new Hono()

	// Body size limit - prevents OOM from large payloads
	app.use(
		'*',
		bodyLimit({
			maxSize: 10 * 1024 * 1024, // 10 MB
			onError: (c) => c.json({ error: 'Request body too large', maxSize: '10MB' }, 413),
		}),
	)

	attachGlobalErrorHandler(app)
	app.use(cors())
	app.use('*', async (_c, next) => {
		return config.effectRuntime.runPromise(
			Effect.gen(function* () {
				const metrics = yield* ConnectionMetrics
				return yield* metrics.trackRequest(Effect.promise(() => next()))
			}),
		)
	})
	app.get('/', async (c) => c.json({ status: 'online' }))

	// Electric serves everything uncompressed by design and expects the proxy in
	// front of it to negotiate encoding, so gzip all responses here. Streaming
	// routes opt out automatically by declaring `Cache-Control: no-transform`
	// (see routes/streams.ts) — compress honors it, as do compliant intermediaries.
	if (config.compress !== false) app.use('*', compress())

	const v1App = createV1App(config)
	const v2App = createV2App(config)
	const v3App = createV3App(config)
	const streamsApp = createStreamsApp(config, { taskDiffs: false, prStatus: false })
	const v2StreamsApp = createStreamsApp(config, { sessions: false })

	// Handle collaboration before the Electric v2 wildcard middleware.
	app.route('/', createResponseEditorCollaborationApp(config))
	app.route('/v1', v1App)
	app.route('/v2', v2App)
	app.route('/v3', v3App)
	app.route('/v2/streams', v2StreamsApp)
	app.route('/streams', streamsApp)

	return app
}

declare module 'hono' {
	interface ContextVariableMap {
		electricOriginUrl: URL
		authContext: SimpleAuthContext
	}
}
