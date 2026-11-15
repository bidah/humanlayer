/**
 * Revocation of cloud host daemon tokens on the sync proxy. Same rules as the API
 * (apps/riptide-api/src/auth/cloud-host-revocation.ts):
 *
 * - Only tokens carrying the signed `cloudHost: true` claim are checked; ordinary daemon tokens
 *   never touch the database.
 * - A cloud token is accepted while its `cloud_hosts` row exists and `revoked_at` is null, looked
 *   up by primary key (organization_id, user_id, host_id).
 * - Per isolate/process, "active" is cached for ACTIVE_TTL_MS and "revoked" forever, so a
 *   streaming daemon costs at most one lookup per ACTIVE_TTL_MS and a destroyed host is cut off
 *   within ACTIVE_TTL_MS. Lookup failures reject the request and are not cached.
 */
import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { and, eq } from 'drizzle-orm'

import type { DbClient } from '../lib/queries'

export interface CloudHostTokenKey {
	readonly organizationId: string
	readonly userId: string
	readonly hostId: string
}

export type CloudHostRevocationLookup = (key: CloudHostTokenKey) => Promise<{ revokedAt: bigint | null } | null>

export const CLOUD_HOST_TOKEN_ACTIVE_TTL_MS = 10_000
const MAX_CACHE_ENTRIES = 10_000

export interface CloudHostTokenGate {
	isActive(key: CloudHostTokenKey): Promise<boolean>
}

export function makeCloudHostTokenGate(
	lookup: CloudHostRevocationLookup,
	options: { activeTtlMs?: number; now?: () => number } = {},
): CloudHostTokenGate {
	const activeTtlMs = options.activeTtlMs ?? CLOUD_HOST_TOKEN_ACTIVE_TTL_MS
	const now = options.now ?? Date.now
	// Plain values only: a promise created in one Worker request must not be awaited by another.
	const cache = new Map<string, { active: boolean; until: number }>()
	return {
		async isActive(key) {
			const cacheKey = `${key.organizationId}\u0000${key.userId}\u0000${key.hostId}`
			const cached = cache.get(cacheKey)
			if (cached && cached.until > now()) return cached.active
			const row = await lookup(key)
			const active = row !== null && row.revokedAt === null
			if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
			cache.set(cacheKey, { active, until: active ? now() + activeTtlMs : Number.POSITIVE_INFINITY })
			return active
		},
	}
}

/** `getDb` is read per lookup, so building the gate never touches the database client. */
export function makeCloudHostRevocationLookup(getDb: () => DbClient): CloudHostRevocationLookup {
	return async (key) => {
		const [row] = await getDb()
			.select({ revokedAt: cloudHosts.revoked_at })
			.from(cloudHosts)
			.where(
				and(
					eq(cloudHosts.organization_id, key.organizationId),
					eq(cloudHosts.user_id, key.userId),
					eq(cloudHosts.host_id, key.hostId),
				),
			)
			.limit(1)
		return row ?? null
	}
}
