// Sessions (`sid`), access tokens (RS256 JWT, WorkOS claim layout) and rotating refresh tokens.
import { getMembershipFor, getOrganizationRow, organizationMetadata, serializeUser, type UserRow } from './db'
import type { Config, Env } from './env'
import { type AccessTokenClaims, signJwt } from './jwt'
import { newId, randomToken, sha256b64 } from './util'

export const issuer = (config: Config) => `${config.publicUrl}/user_management/${config.clientId}`

export interface SessionRow {
	id: string
	user_id: string
	client_id: string
	organization_id: string | null
	browser_session_id: string | null
	auth_method: string
	status: string
	created_at: number
	expires_at: number
	ended_at: number | null
}

export async function createSession(
	env: Env,
	config: Config,
	input: { userId: string; organizationId: string | null; browserSessionId: string | null },
): Promise<SessionRow> {
	const now = Date.now()
	const row: SessionRow = {
		id: newId('session'),
		user_id: input.userId,
		client_id: config.clientId,
		organization_id: input.organizationId,
		browser_session_id: input.browserSessionId,
		auth_method: 'Password',
		status: 'active',
		created_at: now,
		expires_at: now + config.refreshTokenTtlSeconds * 1000,
		ended_at: null,
	}
	await env.DB.prepare(
		'INSERT INTO sessions (id, user_id, client_id, organization_id, browser_session_id, auth_method, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(
			row.id,
			row.user_id,
			row.client_id,
			row.organization_id,
			row.browser_session_id,
			row.auth_method,
			row.status,
			row.created_at,
			row.expires_at,
		)
		.run()
	return row
}

export async function revokeSession(env: Env, sessionId: string, status: 'ended' | 'revoked'): Promise<void> {
	const now = Date.now()
	await env.DB.batch([
		env.DB.prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ? AND status = 'active'").bind(
			status,
			now,
			sessionId,
		),
		env.DB.prepare(
			'UPDATE refresh_tokens SET used_at = COALESCE(used_at, ?), expires_at = ? WHERE session_id = ?',
		).bind(now, now, sessionId),
	])
}

async function accessToken(env: Env, config: Config, session: SessionRow, user: UserRow): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims: AccessTokenClaims = {
		iss: issuer(config),
		sub: user.id,
		sid: session.id,
		jti: newId('jti'),
	}
	if (session.organization_id) {
		const membership = await getMembershipFor(env.DB, user.id, session.organization_id)
		const org = await getOrganizationRow(env.DB, session.organization_id)
		if (membership?.status === 'active' && org) {
			claims.org_id = org.id
			claims.role = membership.role_slug
			claims.roles = [membership.role_slug]
			claims.permissions = []
			claims.entitlements = []
			claims.feature_flags = []
			// Upstream gets this from a WorkOS JWT template mapping organization.metadata.internal_org_id.
			const internalOrgId = organizationMetadata(org).internal_org_id
			if (internalOrgId) claims.internal_org_id = internalOrgId
		}
	}
	claims.iat = now
	claims.exp = now + config.accessTokenTtlSeconds
	return signJwt(env, claims)
}

/** The body of a successful POST /user_management/authenticate (snake_case, as WorkOS returns it). */
export async function issueTokens(env: Env, config: Config, session: SessionRow, user: UserRow) {
	const refreshToken = randomToken(32)
	const now = Date.now()
	await env.DB.prepare(
		'INSERT INTO refresh_tokens (token_hash, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
	)
		.bind(
			await sha256b64(refreshToken),
			session.id,
			now,
			Math.min(session.expires_at, now + config.refreshTokenTtlSeconds * 1000),
		)
		.run()
	return {
		user: serializeUser(user),
		organization_id: session.organization_id ?? undefined,
		access_token: await accessToken(env, config, session, user),
		refresh_token: refreshToken,
		authentication_method: session.auth_method,
	}
}
