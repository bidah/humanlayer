// Row types, wire serializers (snake_case JSON exactly as the WorkOS API returns it) and shared queries.
import { unprocessable } from './util'

export interface UserRow {
	id: string
	email: string
	email_verified: number
	first_name: string | null
	last_name: string | null
	password_hash: string | null
	external_id: string | null
	metadata: string
	last_sign_in_at: string | null
	created_at: string
	updated_at: string
}

export interface OrganizationRow {
	id: string
	name: string
	external_id: string | null
	stripe_customer_id: string | null
	metadata: string
	created_at: string
	updated_at: string
}

export interface DomainRow {
	id: string
	organization_id: string
	domain: string
	state: string
	verification_strategy: string
	verification_token: string | null
	created_at: string
	updated_at: string
}

export interface MembershipRow {
	id: string
	user_id: string
	organization_id: string
	role_slug: string
	status: string
	created_at: string
	updated_at: string
	organization_name?: string
}

export interface InvitationRow {
	id: string
	email: string
	organization_id: string | null
	inviter_user_id: string | null
	accepted_user_id: string | null
	role_slug: string | null
	token: string
	state: string
	expires_at: string
	accepted_at: string | null
	revoked_at: string | null
	created_at: string
	updated_at: string
}

export interface ApiKeyRow {
	id: string
	value_hash: string
	obfuscated_value: string
	user_id: string
	organization_id: string
	name: string
	permissions: string
	expires_at: string | null
	last_used_at: string | null
	created_at: string
	updated_at: string
}

function parseObject(raw: string | null | undefined): Record<string, unknown> {
	try {
		const value = JSON.parse(raw ?? '{}')
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	} catch {
		return {}
	}
}

export function serializeUser(row: UserRow) {
	const name = [row.first_name, row.last_name].filter(Boolean).join(' ') || null
	return {
		object: 'user',
		id: row.id,
		email: row.email,
		email_verified: row.email_verified === 1,
		name,
		first_name: row.first_name,
		last_name: row.last_name,
		profile_picture_url: null,
		last_sign_in_at: row.last_sign_in_at,
		locale: null,
		external_id: row.external_id,
		metadata: parseObject(row.metadata),
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function serializeDomain(row: DomainRow) {
	return {
		object: 'organization_domain',
		id: row.id,
		domain: row.domain,
		organization_id: row.organization_id,
		state: row.state,
		verification_strategy: row.verification_strategy,
		// undefined is dropped by JSON.stringify, matching WorkOS omitting the field
		verification_token: row.verification_token ?? undefined,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function organizationMetadata(row: OrganizationRow): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(parseObject(row.metadata))) if (typeof v === 'string') out[k] = v
	return out
}

export function serializeOrganization(row: OrganizationRow, domains: DomainRow[]) {
	return {
		object: 'organization',
		id: row.id,
		name: row.name,
		allow_profiles_outside_organization: false,
		domains: domains.map(serializeDomain),
		stripe_customer_id: row.stripe_customer_id ?? undefined,
		external_id: row.external_id,
		metadata: organizationMetadata(row),
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function serializeMembership(row: MembershipRow) {
	return {
		object: 'organization_membership',
		id: row.id,
		user_id: row.user_id,
		organization_id: row.organization_id,
		organization_name: row.organization_name ?? null,
		status: row.status,
		role: { slug: row.role_slug },
		roles: [{ slug: row.role_slug }],
		directory_managed: false,
		custom_attributes: {},
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function invitationState(row: InvitationRow, now = Date.now()): string {
	if (row.state === 'pending' && Date.parse(row.expires_at) <= now) return 'expired'
	return row.state
}

export function acceptInvitationUrl(publicUrl: string, token: string): string {
	return `${publicUrl}/invitations/accept?invitation_token=${encodeURIComponent(token)}`
}

export function serializeInvitation(row: InvitationRow, publicUrl: string) {
	return {
		object: 'invitation',
		id: row.id,
		email: row.email,
		state: invitationState(row),
		accepted_at: row.accepted_at,
		revoked_at: row.revoked_at,
		expires_at: row.expires_at,
		organization_id: row.organization_id,
		inviter_user_id: row.inviter_user_id,
		accepted_user_id: row.accepted_user_id,
		role_slug: row.role_slug,
		token: row.token,
		accept_invitation_url: acceptInvitationUrl(publicUrl, row.token),
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

export function serializeApiKey(row: ApiKeyRow) {
	let permissions: string[] = []
	try {
		const parsed = JSON.parse(row.permissions)
		if (Array.isArray(parsed)) permissions = parsed.filter((p) => typeof p === 'string')
	} catch {}
	return {
		object: 'api_key',
		id: row.id,
		owner: { type: 'user', id: row.user_id, organization_id: row.organization_id },
		name: row.name,
		obfuscated_value: row.obfuscated_value,
		last_used_at: row.last_used_at,
		expires_at: row.expires_at,
		permissions,
		created_at: row.created_at,
		updated_at: row.updated_at,
	}
}

// ---- queries ----

export const getUser = (db: D1Database, id: string) =>
	db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()

export const getUserByEmail = (db: D1Database, email: string) =>
	db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>()

export const getOrganizationRow = (db: D1Database, id: string) =>
	db.prepare('SELECT * FROM organizations WHERE id = ?').bind(id).first<OrganizationRow>()

export async function getDomains(db: D1Database, organizationId: string): Promise<DomainRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM organization_domains WHERE organization_id = ? ORDER BY created_at')
		.bind(organizationId)
		.all<DomainRow>()
	return results
}

const MEMBERSHIP_SELECT =
	'SELECT m.*, o.name AS organization_name FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id'

export const getMembership = (db: D1Database, id: string) =>
	db.prepare(`${MEMBERSHIP_SELECT} WHERE m.id = ?`).bind(id).first<MembershipRow>()

export const getMembershipFor = (db: D1Database, userId: string, organizationId: string) =>
	db
		.prepare(`${MEMBERSHIP_SELECT} WHERE m.user_id = ? AND m.organization_id = ?`)
		.bind(userId, organizationId)
		.first<MembershipRow>()

export async function activeMemberships(db: D1Database, userId: string): Promise<MembershipRow[]> {
	const { results } = await db
		.prepare(`${MEMBERSHIP_SELECT} WHERE m.user_id = ? AND m.status = 'active' ORDER BY o.name`)
		.bind(userId)
		.all<MembershipRow>()
	return results
}

export { MEMBERSHIP_SELECT }

/**
 * Cursor pagination over a ULID-keyed table, WorkOS style: `limit` (1..100, default 10), `order`
 * (desc default), `after`/`before` cursors (ids), and `list_metadata: { before, after }`.
 */
export async function paginate<Row extends { id: string }, Out>(
	db: D1Database,
	opts: {
		select: string
		idColumn: string
		where: string[]
		params: unknown[]
		query: URLSearchParams
		serialize: (row: Row) => Out
	},
) {
	const order = opts.query.get('order') === 'asc' ? 'asc' : 'desc'
	const limitRaw = opts.query.get('limit')
	const limit = limitRaw === null ? 10 : Number.parseInt(limitRaw, 10)
	if (!Number.isFinite(limit) || limit < 1 || limit > 100)
		throw unprocessable('limit must be between 1 and 100', 'limit')
	const after = opts.query.get('after')
	const before = opts.query.get('before')
	const where = [...opts.where]
	const params = [...opts.params]
	let sqlOrder = order
	if (after) {
		where.push(`${opts.idColumn} ${order === 'desc' ? '<' : '>'} ?`)
		params.push(after)
	} else if (before) {
		where.push(`${opts.idColumn} ${order === 'desc' ? '>' : '<'} ?`)
		params.push(before)
		sqlOrder = order === 'desc' ? 'asc' : 'desc'
	}
	const sql = `${opts.select}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${opts.idColumn} ${sqlOrder} LIMIT ?`
	const { results } = await db
		.prepare(sql)
		.bind(...params, limit + 1)
		.all<Row>()
	const hasMore = results.length > limit
	let page = results.slice(0, limit)
	if (before && !after) page = page.reverse()
	const first = page[0]?.id ?? null
	const last = page[page.length - 1]?.id ?? null
	return {
		object: 'list',
		data: page.map(opts.serialize),
		list_metadata: {
			before: before ? (hasMore ? first : null) : after ? first : null,
			after: before ? last : hasMore ? last : null,
		},
	}
}
