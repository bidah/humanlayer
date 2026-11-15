import { type Env, isAllowedCorsOrigin, loadConfig } from './env'
import { jwks } from './jwt'
import { handleManagement } from './management'
import {
	authenticate,
	authorizeGet,
	authorizePost,
	deviceAuthorize,
	deviceGet,
	devicePost,
	invitationGet,
	invitationPost,
	invitationsAdmin,
	logout,
	switchAccount,
} from './oauth'
import { messagePage } from './pages'
import { ApiError, json } from './util'

// Browser-callable endpoints (token exchange from @workos-inc/authkit-js, and JWKS).
const CORS_PATHS = new Set(['/user_management/authenticate'])

function corsHeaders(req: Request, allowed: boolean): Headers {
	const headers = new Headers({ vary: 'Origin' })
	const origin = req.headers.get('origin')
	if (!origin || !allowed) return headers
	headers.set('access-control-allow-origin', origin)
	headers.set('access-control-allow-credentials', 'true')
	headers.set('access-control-allow-methods', 'POST, OPTIONS')
	headers.set('access-control-allow-headers', 'content-type, accept')
	headers.set('access-control-max-age', '600')
	return headers
}

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const config = loadConfig(env, url)
	const c = { env, ctx, config, req, url }
	const path = url.pathname
	const method = req.method

	if (path === '/' && method === 'GET') {
		return messagePage(
			'HumanLayer sign-in',
			'This service handles sign-in for HumanLayer. Open the HumanLayer app to sign in.',
		)
	}
	if (path === '/health') return json({ ok: true })

	const jwksClient = /^\/sso\/jwks\/([^/]+)$/.exec(path)?.[1]
	if (jwksClient !== undefined && method === 'GET') {
		if (decodeURIComponent(jwksClient) !== config.clientId) return json({ message: 'Client not found.' }, 404)
		return json(jwks(env), 200, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' })
	}

	if (CORS_PATHS.has(path)) {
		const origin = req.headers.get('origin')
		const allowed = origin !== null && isAllowedCorsOrigin(config, origin)
		if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, allowed) })
		if (method === 'POST') {
			let res: Response
			try {
				res = await authenticate(c)
			} catch (error) {
				res = errorResponse(error)
			}
			for (const [k, v] of corsHeaders(req, allowed)) res.headers.set(k, v)
			return res
		}
	}

	if (path === '/user_management/authorize') {
		if (method === 'GET') return authorizeGet(c)
		if (method === 'POST') return authorizePost(c)
	}
	if (path === '/user_management/authorize/device' && method === 'POST') return deviceAuthorize(c)
	if (path === '/device') {
		if (method === 'GET') return deviceGet(c)
		if (method === 'POST') return devicePost(c)
	}
	if (path === '/user_management/sessions/logout' && method === 'GET') return logout(c)
	if (path === '/session/switch' && method === 'POST') return switchAccount(c)
	if (path === '/invitations/accept') {
		if (method === 'GET') return invitationGet(c)
		if (method === 'POST') return invitationPost(c)
	}
	if (path === '/invitations' && (method === 'GET' || method === 'POST')) return invitationsAdmin(c)

	const management = await handleManagement(c)
	if (management) return management

	return json({ message: 'Not found.', code: 'not_found' }, 404)
}

function errorResponse(error: unknown): Response {
	if (error instanceof ApiError) return json(error.body, error.status)
	console.error('unhandled error', error instanceof Error ? error.message : 'unknown')
	return json({ message: 'Internal server error.' }, 500)
}

export default {
	async fetch(req, env, ctx): Promise<Response> {
		const url = new URL(req.url)
		try {
			return await route(req, env, ctx, url)
		} catch (error) {
			return errorResponse(error)
		}
	},
} satisfies ExportedHandler<Env>
