import { Hono } from 'hono'
import { z } from 'zod'

import { isAuthorized } from './auth'
import { type ArtifactBucket, resolveCliArtifact, serveCliArtifact } from './cli-artifacts'
import type { Env } from './env'
import { providerConfigured, type ProviderDeps, selectProvider } from './providers'
import { ProviderError, type HostSummary } from './providers/types'
import { redact } from './redact'
import {
	CreateHostRequest,
	HostPathParams,
	ListQuery,
	LogsQuery,
	PROVIDERS,
	type ProviderName,
	RebootstrapRequest,
} from './schemas'

export interface AppOptions {
	/** Overrides for tests: fake fetch / fake Cloudflare stubs. */
	deps?: ProviderDeps
	bucket?: ArtifactBucket
}

type HonoEnv = { Bindings: Env }

interface ErrorBody {
	error: { code: string; message: string; details?: unknown }
}

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
	const body: ErrorBody = { error: { code, message } }
	if (details !== undefined) body.error.details = details
	return body
}

export function createApp(opts: AppOptions = {}) {
	const app = new Hono<HonoEnv>()
	const bucket = (env: Env): ArtifactBucket => opts.bucket ?? env.ARTIFACTS

	app.onError((err, c) => {
		if (err instanceof ProviderError) {
			return c.json(errorBody(err.code, redact(err.message)), err.httpStatus as 400)
		}
		if (err instanceof z.ZodError) return c.json(errorBody('invalid_request', 'validation failed', err.issues), 400)
		console.error(JSON.stringify({ event: 'unhandled', message: redact(String(err?.message ?? err)) }))
		return c.json(errorBody('internal', redact(String(err?.message ?? err)).slice(0, 500)), 500)
	})

	// ---------------------------------------------------------------- public
	app.get('/health', (c) =>
		c.json({
			ok: true,
			service: 'human-flare-hosts',
			providers: Object.fromEntries(PROVIDERS.map((p) => [p, providerConfigured(p, c.env)])),
		}),
	)
	app.on(['GET', 'HEAD'], '/cli/latest.json', (c) =>
		serveCliArtifact(bucket(c.env), 'latest', 'manifest.json', c.req.method),
	)
	app.on(['GET', 'HEAD'], '/cli/:version/:file', (c) =>
		serveCliArtifact(bucket(c.env), c.req.param('version'), c.req.param('file'), c.req.method),
	)

	// ---------------------------------------------------------------- internal (bearer auth)
	const v1 = new Hono<HonoEnv>()
	v1.use('*', async (c, next) => {
		if (!(await isAuthorized(c.req.header('authorization'), c.env.INTERNAL_SERVICE_SECRET))) {
			return c.json(errorBody('unauthorized', 'missing or invalid bearer token'), 401)
		}
		await next()
	})

	const parseJson = async (req: Request) => {
		try {
			return await req.json()
		} catch {
			throw new ProviderError('invalid_request', 'body must be JSON')
		}
	}
	const pathParams = (c: { req: { param(k: string): string } }) =>
		HostPathParams.parse({ provider: c.req.param('provider'), hostId: c.req.param('hostId') })
	const provider = (name: ProviderName, env: Env) => selectProvider(name, env, opts.deps)

	v1.post('/hosts', async (c) => {
		const body = CreateHostRequest.parse(await parseJson(c.req.raw))
		const p = provider(body.provider, c.env)
		const cli = await resolveCliArtifact(bucket(c.env), new URL(c.req.url).origin, body.cliVersion)
		const result = await p.create({
			hostId: body.hostId,
			daemonToken: body.daemonToken,
			env: body.env,
			ttlMinutes: body.ttlMinutes,
			size: body.size,
			labels: body.labels,
			cli,
		})
		return c.json(result, result.created ? 201 : 200)
	})

	v1.get('/hosts', async (c) => {
		const q = ListQuery.parse({ provider: c.req.query('provider') })
		const names = q.provider
			? [q.provider]
			: PROVIDERS.filter((p) => providerConfigured(p, c.env) || (p === 'cloudflare' && opts.deps?.cloudflare))
		const hosts: HostSummary[] = []
		const errors: Array<{ provider: ProviderName; message: string }> = []
		await Promise.all(
			names.map(async (n) => {
				try {
					hosts.push(...(await provider(n, c.env).list()))
				} catch (e) {
					if (q.provider) throw e
					errors.push({ provider: n, message: redact(e instanceof Error ? e.message : String(e)) })
				}
			}),
		)
		return c.json({ hosts, errors })
	})

	v1.get('/hosts/:provider/:hostId', async (c) => {
		const { provider: name, hostId } = pathParams(c)
		const host = await provider(name, c.env).status(hostId)
		return c.json({ host }, host.state === 'not_found' ? 404 : 200)
	})

	v1.get('/hosts/:provider/:hostId/logs', async (c) => {
		const { provider: name, hostId } = pathParams(c)
		const { lines } = LogsQuery.parse({ lines: c.req.query('lines') })
		return c.json(await provider(name, c.env).logs(hostId, lines))
	})

	v1.post('/hosts/:provider/:hostId/bootstrap', async (c) => {
		const { provider: name, hostId } = pathParams(c)
		const body = RebootstrapRequest.parse(await parseJson(c.req.raw))
		const cli = await resolveCliArtifact(bucket(c.env), new URL(c.req.url).origin, body.cliVersion)
		const host = await provider(name, c.env).rebootstrap({
			hostId,
			daemonToken: body.daemonToken,
			env: body.env,
			cli,
		})
		return c.json({ host })
	})

	v1.delete('/hosts/:provider/:hostId', async (c) => {
		const { provider: name, hostId } = pathParams(c)
		const r = await provider(name, c.env).destroy(hostId)
		return c.json({ provider: name, hostId, ...r }, r.destroyed ? 200 : 404)
	})

	app.route('/v1', v1)
	app.notFound((c) => c.json(errorBody('not_found', 'no such route'), 404))
	return app
}
