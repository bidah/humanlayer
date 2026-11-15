// The server-side (API-key authenticated) subset of the WorkOS REST API that @workos-inc/node
// calls from riptide-api. Paths, parameters and response bodies follow the SDK serializers.
import {
	type ApiKeyRow,
	type DomainRow,
	getDomains,
	getMembership,
	getMembershipFor,
	getOrganizationRow,
	getUser,
	getUserByEmail,
	type InvitationRow,
	invitationState,
	MEMBERSHIP_SELECT,
	type MembershipRow,
	paginate,
	serializeApiKey,
	serializeDomain,
	serializeInvitation,
	serializeMembership,
	serializeOrganization,
	serializeUser,
	type UserRow,
} from './db'
import type { Config, Env } from './env'
import {
	ApiError,
	badRequest,
	EMAIL_RE,
	json,
	newId,
	normalizeEmail,
	notFound,
	nowIso,
	randomToken,
	secretEqual,
	sha256b64,
	unprocessable,
} from './util'
import { emitMembershipEvent } from './webhooks'

type Ctx = { env: Env; ctx: ExecutionContext; config: Config; req: Request; url: URL }
type Handler = (c: Ctx, param: string) => Promise<Response>

const DOMAIN_RE = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i

async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text()
	if (!text) return {}
	try {
		const parsed = JSON.parse(text)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch {
		throw unprocessable('Request body must be JSON')
	}
}

/** A row that was just written must exist; anything else is a server error. */
function must<T>(row: T | null | undefined): T {
	if (row === null || row === undefined) throw new ApiError(500, { message: 'Internal server error.' })
	return row
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export async function isApiKeyAuthorized(env: Env, req: Request): Promise<boolean> {
	const header = req.headers.get('authorization') ?? ''
	const presented = /^Bearer (.+)$/.exec(header)?.[1]
	if (!presented || !env.API_KEY) return false
	return secretEqual(presented, env.API_KEY)
}

// ---- users ----

const getUserHandler: Handler = async ({ env }, id) => {
	const user = await getUser(env.DB, id)
	if (!user) throw notFound('User')
	return json(serializeUser(user))
}

const listUsersHandler: Handler = async ({ env, url }) => {
	const where: string[] = []
	const params: unknown[] = []
	const email = url.searchParams.get('email')
	if (email) {
		where.push('u.email = ?')
		params.push(normalizeEmail(email))
	}
	const orgId = url.searchParams.get('organization_id')
	if (orgId) {
		where.push('u.id IN (SELECT user_id FROM organization_memberships WHERE organization_id = ?)')
		params.push(orgId)
	}
	return json(
		await paginate<UserRow, unknown>(env.DB, {
			select: 'SELECT u.* FROM users u',
			idColumn: 'u.id',
			where,
			params,
			query: url.searchParams,
			serialize: serializeUser,
		}),
	)
}

// ---- organizations ----

async function organizationResponse(env: Env, id: string) {
	const org = await getOrganizationRow(env.DB, id)
	if (!org) throw notFound('Organization')
	return serializeOrganization(org, await getDomains(env.DB, id))
}

function parseDomainData(value: unknown): Array<{ domain: string; state: string }> {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) throw unprocessable('domain_data must be an array', 'domain_data')
	return value.map((entry) => {
		const domain = str((entry as Record<string, unknown>)?.domain)?.toLowerCase()
		const state = str((entry as Record<string, unknown>)?.state) ?? 'pending'
		if (!domain || !DOMAIN_RE.test(domain)) throw unprocessable('Invalid domain', 'domain_data')
		if (state !== 'pending' && state !== 'verified') throw unprocessable('Invalid domain state', 'domain_data')
		return { domain, state }
	})
}

function domainInsert(env: Env, organizationId: string, domain: string, state: string) {
	const now = nowIso()
	return env.DB.prepare(
		'INSERT INTO organization_domains (id, organization_id, domain, state, verification_strategy, verification_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
	).bind(
		newId('org_domain'),
		organizationId,
		domain,
		state,
		state === 'verified' ? 'manual' : 'dns',
		randomToken(12),
		now,
		now,
	)
}

async function assertDomainsFree(env: Env, domains: string[], organizationId?: string) {
	for (const domain of domains) {
		const existing = await env.DB.prepare('SELECT organization_id FROM organization_domains WHERE domain = ?')
			.bind(domain)
			.first<{ organization_id: string }>()
		if (existing && existing.organization_id !== organizationId) {
			throw badRequest('domain_already_in_use', `Domain ${domain} is already in use by another organization.`)
		}
	}
}

function mergeMetadata(existing: string, patch: unknown): string {
	if (patch === undefined) return existing
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
		throw unprocessable('metadata must be an object', 'metadata')
	const out: Record<string, string> = JSON.parse(existing || '{}')
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		if (key.length > 40) throw unprocessable('metadata keys are limited to 40 characters', 'metadata')
		if (value === null || value === '') delete out[key]
		else if (typeof value === 'string' && value.length <= 600) out[key] = value
		else throw unprocessable('metadata values must be strings of at most 600 characters', 'metadata')
	}
	if (Object.keys(out).length > 50) throw unprocessable('metadata is limited to 50 keys', 'metadata')
	return JSON.stringify(out)
}

const createOrganizationHandler: Handler = async ({ env, req }) => {
	const input = await body(req)
	const name = str(input.name)
	if (!name) throw unprocessable('name is required', 'name')
	const domains = parseDomainData(input.domain_data)
	await assertDomainsFree(
		env,
		domains.map((d) => d.domain),
	)
	const id = newId('org')
	const now = nowIso()
	const metadata = mergeMetadata('{}', input.metadata ?? {})
	await env.DB.batch([
		env.DB.prepare(
			'INSERT INTO organizations (id, name, external_id, stripe_customer_id, metadata, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)',
		).bind(id, name, str(input.external_id) ?? null, metadata, now, now),
		...domains.map((d) => domainInsert(env, id, d.domain, d.state)),
	])
	return json(await organizationResponse(env, id), 201)
}

const getOrganizationHandler: Handler = async ({ env }, id) => json(await organizationResponse(env, id))

const updateOrganizationHandler: Handler = async ({ env, req }, id) => {
	const org = await getOrganizationRow(env.DB, id)
	if (!org) throw notFound('Organization')
	const input = await body(req)
	const statements: D1PreparedStatement[] = []
	const metadata = mergeMetadata(org.metadata, input.metadata)
	statements.push(
		env.DB.prepare(
			'UPDATE organizations SET name = ?, external_id = ?, stripe_customer_id = ?, metadata = ?, updated_at = ? WHERE id = ?',
		).bind(
			str(input.name) ?? org.name,
			input.external_id === undefined ? org.external_id : (str(input.external_id) ?? null),
			input.stripe_customer_id === undefined ? org.stripe_customer_id : (str(input.stripe_customer_id) ?? null),
			metadata,
			nowIso(),
			org.id,
		),
	)
	if (input.domain_data !== undefined) {
		const domains = parseDomainData(input.domain_data)
		await assertDomainsFree(
			env,
			domains.map((d) => d.domain),
			org.id,
		)
		statements.push(env.DB.prepare('DELETE FROM organization_domains WHERE organization_id = ?').bind(org.id))
		statements.push(...domains.map((d) => domainInsert(env, org.id, d.domain, d.state)))
	}
	await env.DB.batch(statements)
	return json(await organizationResponse(env, org.id))
}

const createDomainHandler: Handler = async ({ env, req }) => {
	const input = await body(req)
	const domain = str(input.domain)?.toLowerCase()
	const organizationId = str(input.organization_id)
	if (!domain || !DOMAIN_RE.test(domain)) throw unprocessable('Invalid domain', 'domain')
	if (!organizationId || !(await getOrganizationRow(env.DB, organizationId))) throw notFound('Organization')
	await assertDomainsFree(env, [domain])
	const existing = await env.DB.prepare('SELECT id FROM organization_domains WHERE domain = ?').bind(domain).first()
	if (existing) throw badRequest('domain_already_exists', 'This domain already exists in the organization.')
	await domainInsert(env, organizationId, domain, 'pending').run()
	const row = await env.DB.prepare('SELECT * FROM organization_domains WHERE domain = ?')
		.bind(domain)
		.first<DomainRow>()
	return json(serializeDomain(must(row)), 201)
}

const deleteDomainHandler: Handler = async ({ env }, id) => {
	const result = await env.DB.prepare('DELETE FROM organization_domains WHERE id = ?').bind(id).run()
	if (!result.meta.changes) throw notFound('Organization domain')
	return new Response(null, { status: 202 })
}

// ---- memberships ----

function parseRole(config: Config, input: Record<string, unknown>, fallback: string): string {
	const roleSlugs = Array.isArray(input.role_slugs) ? input.role_slugs : undefined
	const slug =
		str(input.role_slug) ?? (roleSlugs && typeof roleSlugs[0] === 'string' ? roleSlugs[0] : undefined) ?? fallback
	if (!config.roleSlugs.has(slug)) throw unprocessable(`Unknown role: ${slug}`, 'role_slug')
	return slug
}

const listMembershipsHandler: Handler = async ({ env, url }) => {
	const userId = url.searchParams.get('user_id')
	const orgId = url.searchParams.get('organization_id')
	if (!userId && !orgId) throw unprocessable('Either user_id or organization_id is required', 'user_id')
	const where: string[] = []
	const params: unknown[] = []
	if (userId) {
		where.push('m.user_id = ?')
		params.push(userId)
	}
	if (orgId) {
		where.push('m.organization_id = ?')
		params.push(orgId)
	}
	const statuses = (url.searchParams.get('statuses') ?? 'active')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	for (const s of statuses)
		if (!['active', 'inactive', 'pending'].includes(s)) throw unprocessable(`Invalid status ${s}`, 'statuses')
	where.push(`m.status IN (${statuses.map(() => '?').join(', ')})`)
	params.push(...statuses)
	return json(
		await paginate<MembershipRow, unknown>(env.DB, {
			select: MEMBERSHIP_SELECT,
			idColumn: 'm.id',
			where,
			params,
			query: url.searchParams,
			serialize: serializeMembership,
		}),
	)
}

const createMembershipHandler: Handler = async ({ env, ctx, config, req }) => {
	const input = await body(req)
	const userId = str(input.user_id)
	const orgId = str(input.organization_id)
	if (!userId || !(await getUser(env.DB, userId))) throw notFound('User')
	if (!orgId || !(await getOrganizationRow(env.DB, orgId))) throw notFound('Organization')
	const role = parseRole(config, input, 'member')
	const existing = await getMembershipFor(env.DB, userId, orgId)
	const now = nowIso()
	if (existing && existing.status === 'active') {
		throw badRequest('organization_membership_already_exists', 'User already a member of organization.')
	}
	if (existing) {
		await env.DB.prepare(
			"UPDATE organization_memberships SET status = 'active', role_slug = ?, updated_at = ? WHERE id = ?",
		)
			.bind(role, now, existing.id)
			.run()
	} else {
		await env.DB.prepare(
			"INSERT INTO organization_memberships (id, user_id, organization_id, role_slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
		)
			.bind(newId('om'), userId, orgId, role, now, now)
			.run()
	}
	const row = must(await getMembershipFor(env.DB, userId, orgId))
	emitMembershipEvent(env, ctx, existing ? 'organization_membership.updated' : 'organization_membership.created', row)
	return json(serializeMembership(row), 201)
}

const updateMembershipHandler: Handler = async ({ env, ctx, config, req }, id) => {
	const existing = await getMembership(env.DB, id)
	if (!existing) throw notFound('Organization membership')
	const role = parseRole(config, await body(req), existing.role_slug)
	await env.DB.prepare('UPDATE organization_memberships SET role_slug = ?, updated_at = ? WHERE id = ?')
		.bind(role, nowIso(), id)
		.run()
	const row = must(await getMembership(env.DB, id))
	emitMembershipEvent(env, ctx, 'organization_membership.updated', row)
	return json(serializeMembership(row))
}

const deleteMembershipHandler: Handler = async ({ env, ctx }, id) => {
	const existing = await getMembership(env.DB, id)
	if (!existing) throw notFound('Organization membership')
	await env.DB.prepare('DELETE FROM organization_memberships WHERE id = ?').bind(id).run()
	emitMembershipEvent(env, ctx, 'organization_membership.deleted', existing)
	return new Response(null, { status: 202 })
}

const setMembershipStatus =
	(from: string, to: string): Handler =>
	async ({ env, ctx }, id) => {
		const existing = await getMembership(env.DB, id)
		if (!existing) throw notFound('Organization membership')
		if (existing.status === 'pending') {
			throw badRequest(
				'invalid_membership_state',
				`A pending membership cannot be ${to === 'active' ? 'reactivated' : 'deactivated'}.`,
			)
		}
		if (existing.status === from) {
			await env.DB.prepare('UPDATE organization_memberships SET status = ?, updated_at = ? WHERE id = ?')
				.bind(to, nowIso(), id)
				.run()
			const row = must(await getMembership(env.DB, id))
			emitMembershipEvent(env, ctx, 'organization_membership.updated', row)
			return json(serializeMembership(row))
		}
		return json(serializeMembership(existing))
	}

// ---- invitations ----

const getInvitationRow = (env: Env, id: string) =>
	env.DB.prepare('SELECT * FROM invitations WHERE id = ?').bind(id).first<InvitationRow>()

const listInvitationsHandler: Handler = async ({ env, config, url }) => {
	const where: string[] = []
	const params: unknown[] = []
	const email = url.searchParams.get('email')
	if (email) {
		where.push('email = ?')
		params.push(normalizeEmail(email))
	}
	const orgId = url.searchParams.get('organization_id')
	if (orgId) {
		where.push('organization_id = ?')
		params.push(orgId)
	}
	return json(
		await paginate<InvitationRow, unknown>(env.DB, {
			select: 'SELECT * FROM invitations',
			idColumn: 'id',
			where,
			params,
			query: url.searchParams,
			serialize: (row) => serializeInvitation(row, config.publicUrl),
		}),
	)
}

const getInvitationHandler: Handler = async ({ env, config }, id) => {
	const row = await getInvitationRow(env, id)
	if (!row) throw notFound('Invitation')
	return json(serializeInvitation(row, config.publicUrl))
}

const findInvitationByTokenHandler: Handler = async ({ env, config }, token) => {
	const row = await env.DB.prepare('SELECT * FROM invitations WHERE token = ?').bind(token).first<InvitationRow>()
	if (!row) throw notFound('Invitation')
	return json(serializeInvitation(row, config.publicUrl))
}

const sendInvitationHandler: Handler = async ({ env, config, req }) => {
	const input = await body(req)
	const email = normalizeEmail(str(input.email) ?? '')
	if (!EMAIL_RE.test(email)) throw unprocessable('A valid email is required', 'email')
	const orgId = str(input.organization_id) ?? null
	if (orgId && !(await getOrganizationRow(env.DB, orgId))) throw notFound('Organization')
	const role = orgId ? parseRole(config, input, 'member') : null
	const days = input.expires_in_days === undefined ? 7 : Number(input.expires_in_days)
	if (!Number.isInteger(days) || days < 1 || days > 30)
		throw unprocessable('expires_in_days must be between 1 and 30', 'expires_in_days')
	const inviter = str(input.inviter_user_id) ?? null
	if (inviter && !(await getUser(env.DB, inviter))) throw notFound('Inviter user')

	if (orgId) {
		const user = await getUserByEmail(env.DB, email)
		const membership = user ? await getMembershipFor(env.DB, user.id, orgId) : null
		if (membership?.status === 'active')
			throw badRequest('user_already_organization_member', 'User already a member of organization.')
	}
	const { results: pending } = await env.DB.prepare(
		"SELECT * FROM invitations WHERE email = ? AND state = 'pending' AND organization_id IS ?",
	)
		.bind(email, orgId)
		.all<InvitationRow>()
	if (pending.some((row) => invitationState(row) === 'pending')) {
		throw badRequest('email_already_invited_to_organization', 'Email already invited to organization.')
	}

	const id = newId('invitation')
	const now = nowIso()
	await env.DB.prepare(
		"INSERT INTO invitations (id, email, organization_id, inviter_user_id, accepted_user_id, role_slug, token, state, expires_at, accepted_at, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'pending', ?, NULL, NULL, ?, ?)",
	)
		.bind(
			id,
			email,
			orgId,
			inviter,
			role,
			randomToken(24),
			new Date(Date.now() + days * 86_400_000).toISOString(),
			now,
			now,
		)
		.run()
	// No email is sent: the caller gets accept_invitation_url back, and org admins can list it on /invitations.
	return json(serializeInvitation(must(await getInvitationRow(env, id)), config.publicUrl), 201)
}

/** Accept an invitation for the user whose email it was sent to; activates the org membership. */
export async function acceptInvitationRow(
	env: Env,
	ctx: ExecutionContext,
	invitation: InvitationRow,
	user: UserRow,
): Promise<InvitationRow> {
	const now = nowIso()
	let event: 'organization_membership.created' | 'organization_membership.updated' | undefined
	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			"UPDATE invitations SET state = 'accepted', accepted_at = ?, accepted_user_id = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
		).bind(now, user.id, now, invitation.id),
	]
	if (invitation.organization_id) {
		const existing = await getMembershipFor(env.DB, user.id, invitation.organization_id)
		if (!existing) {
			event = 'organization_membership.created'
			statements.push(
				env.DB.prepare(
					"INSERT INTO organization_memberships (id, user_id, organization_id, role_slug, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
				).bind(newId('om'), user.id, invitation.organization_id, invitation.role_slug ?? 'member', now, now),
			)
		} else if (existing.status !== 'active') {
			event = 'organization_membership.updated'
			statements.push(
				env.DB.prepare(
					"UPDATE organization_memberships SET status = 'active', role_slug = ?, updated_at = ? WHERE id = ?",
				).bind(invitation.role_slug ?? existing.role_slug, now, existing.id),
			)
		}
	}
	statements.push(
		env.DB.prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?').bind(now, user.id),
	)
	const [first] = await env.DB.batch(statements)
	if (!first?.meta.changes) throw badRequest('invitation_not_pending', 'Invitation is no longer pending.')
	if (event && invitation.organization_id) {
		const row = await getMembershipFor(env.DB, user.id, invitation.organization_id)
		if (row) emitMembershipEvent(env, ctx, event, row)
	}
	return must(await getInvitationRow(env, invitation.id))
}

const acceptInvitationHandler: Handler = async ({ env, ctx, config }, id) => {
	const invitation = await getInvitationRow(env, id)
	if (!invitation) throw notFound('Invitation')
	const state = invitationState(invitation)
	if (state !== 'pending') throw badRequest(`invitation_${state}`, `Invitation is ${state}.`)
	const user = await getUserByEmail(env.DB, invitation.email)
	if (!user)
		throw badRequest('user_not_found', 'No user exists for the invitation email; the invitee must sign up first.')
	return json(serializeInvitation(await acceptInvitationRow(env, ctx, invitation, user), config.publicUrl))
}

const revokeInvitationHandler: Handler = async ({ env, config }, id) => {
	const invitation = await getInvitationRow(env, id)
	if (!invitation) throw notFound('Invitation')
	if (invitation.state !== 'pending')
		throw badRequest('invitation_not_pending', `Invitation is ${invitationState(invitation)}.`)
	const now = nowIso()
	await env.DB.prepare("UPDATE invitations SET state = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?")
		.bind(now, now, id)
		.run()
	return json(serializeInvitation(must(await getInvitationRow(env, id)), config.publicUrl))
}

// ---- API keys (user keys, used as personal access tokens) ----

const API_KEY_PREFIX = 'hlk_'

const createUserApiKeyHandler: Handler = async ({ env, req }, userId) => {
	const input = await body(req)
	if (!(await getUser(env.DB, userId))) throw notFound('User')
	const orgId = str(input.organization_id)
	if (!orgId) throw unprocessable('organization_id is required', 'organization_id')
	const membership = await getMembershipFor(env.DB, userId, orgId)
	if (membership?.status !== 'active')
		throw badRequest(
			'organization_membership_required',
			'User does not have an active membership in the organization.',
		)
	const name = str(input.name)
	if (!name || name.length > 200) throw unprocessable('name is required', 'name')
	let expiresAt: string | null = null
	if (input.expires_at !== undefined && input.expires_at !== null) {
		const t = typeof input.expires_at === 'string' ? Date.parse(input.expires_at) : Number.NaN
		if (!Number.isFinite(t) || t <= Date.now())
			throw unprocessable('expires_at must be a future timestamp', 'expires_at')
		expiresAt = new Date(t).toISOString()
	}
	const permissions = Array.isArray(input.permissions) ? input.permissions.filter((p) => typeof p === 'string') : []
	const value = `${API_KEY_PREFIX}${randomToken(32)}`
	const id = newId('api_key')
	const now = nowIso()
	await env.DB.prepare(
		'INSERT INTO api_keys (id, value_hash, obfuscated_value, user_id, organization_id, name, permissions, expires_at, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
	)
		.bind(
			id,
			await sha256b64(value),
			`${API_KEY_PREFIX}...${value.slice(-4)}`,
			userId,
			orgId,
			name,
			JSON.stringify(permissions),
			expiresAt,
			now,
			now,
		)
		.run()
	const row = must(await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>())
	return json({ ...serializeApiKey(row), value }, 201)
}

const listUserApiKeysHandler: Handler = async ({ env, url }, userId) => {
	const where = ['user_id = ?']
	const params: unknown[] = [userId]
	const orgId = url.searchParams.get('organization_id')
	if (orgId) {
		where.push('organization_id = ?')
		params.push(orgId)
	}
	return json(
		await paginate<ApiKeyRow, unknown>(env.DB, {
			select: 'SELECT * FROM api_keys',
			idColumn: 'id',
			where,
			params,
			query: url.searchParams,
			serialize: serializeApiKey,
		}),
	)
}

const validateApiKeyHandler: Handler = async ({ env, req }) => {
	const value = str((await body(req)).value)
	if (!value) throw unprocessable('value is required', 'value')
	const row = await env.DB.prepare('SELECT * FROM api_keys WHERE value_hash = ?')
		.bind(await sha256b64(value))
		.first<ApiKeyRow>()
	if (!row || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) return json({ api_key: null })
	const membership = await getMembershipFor(env.DB, row.user_id, row.organization_id)
	if (membership?.status !== 'active') return json({ api_key: null })
	const now = nowIso()
	await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(now, row.id).run()
	return json({ api_key: serializeApiKey({ ...row, last_used_at: now }) })
}

const deleteApiKeyHandler: Handler = async ({ env }, id) => {
	const result = await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run()
	if (!result.meta.changes) throw notFound('API key')
	return new Response(null, { status: 204 })
}

const portalHandler: Handler = async () => {
	throw new ApiError(400, {
		code: 'not_supported',
		message: 'The Admin Portal is not available on this WorkOS-compatible auth service.',
	})
}

// ---- routing ----

const SEG = '([^/]+)'
const routes: Array<[string, RegExp, Handler]> = [
	['GET', /^\/user_management\/users$/, listUsersHandler],
	['GET', new RegExp(`^/user_management/users/${SEG}/api_keys$`), listUserApiKeysHandler],
	['POST', new RegExp(`^/user_management/users/${SEG}/api_keys$`), createUserApiKeyHandler],
	['GET', new RegExp(`^/user_management/users/${SEG}$`), getUserHandler],
	['GET', /^\/user_management\/organization_memberships$/, listMembershipsHandler],
	['POST', /^\/user_management\/organization_memberships$/, createMembershipHandler],
	[
		'PUT',
		new RegExp(`^/user_management/organization_memberships/${SEG}/deactivate$`),
		setMembershipStatus('active', 'inactive'),
	],
	[
		'PUT',
		new RegExp(`^/user_management/organization_memberships/${SEG}/reactivate$`),
		setMembershipStatus('inactive', 'active'),
	],
	['PUT', new RegExp(`^/user_management/organization_memberships/${SEG}$`), updateMembershipHandler],
	['DELETE', new RegExp(`^/user_management/organization_memberships/${SEG}$`), deleteMembershipHandler],
	['GET', /^\/user_management\/invitations$/, listInvitationsHandler],
	['POST', /^\/user_management\/invitations$/, sendInvitationHandler],
	['GET', new RegExp(`^/user_management/invitations/by_token/${SEG}$`), findInvitationByTokenHandler],
	['POST', new RegExp(`^/user_management/invitations/${SEG}/accept$`), acceptInvitationHandler],
	['POST', new RegExp(`^/user_management/invitations/${SEG}/revoke$`), revokeInvitationHandler],
	['GET', new RegExp(`^/user_management/invitations/${SEG}$`), getInvitationHandler],
	['POST', /^\/organizations$/, createOrganizationHandler],
	['GET', new RegExp(`^/organizations/${SEG}$`), getOrganizationHandler],
	['PUT', new RegExp(`^/organizations/${SEG}$`), updateOrganizationHandler],
	['POST', /^\/organization_domains$/, createDomainHandler],
	['DELETE', new RegExp(`^/organization_domains/${SEG}$`), deleteDomainHandler],
	['POST', /^\/api_keys\/validations$/, validateApiKeyHandler],
	['DELETE', new RegExp(`^/api_keys/${SEG}$`), deleteApiKeyHandler],
	['POST', /^\/portal\/generate_link$/, portalHandler],
]

/** Returns a response for management routes, or null if the path is not one. */
export async function handleManagement(c: Ctx): Promise<Response | null> {
	for (const [method, pattern, handler] of routes) {
		const match = pattern.exec(c.url.pathname)
		if (!match || method !== c.req.method) continue
		if (!(await isApiKeyAuthorized(c.env, c.req))) {
			return json({ message: 'Unauthorized' }, 401)
		}
		return handler(c, decodeURIComponent(match[1] ?? ''))
	}
	return null
}
