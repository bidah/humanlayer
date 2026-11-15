/**
 * Revocation of cloud host daemon tokens.
 *
 * Daemon tokens are RS256 JWTs without `exp`, so a token is valid forever unless something rejects
 * it. Tokens minted for a cloud host carry the signed `cloudHost: true` claim; only those are
 * looked up here, against `cloud_hosts` by its primary key (organization_id, user_id, host_id).
 * A token is accepted while its row exists and `revoked_at` is null. A missing row is rejected:
 * the row is always written before the token leaves the API.
 *
 * Cost: ordinary (non-cloud) daemon tokens never reach this module, so they pay nothing. For cloud
 * tokens the answer is cached per isolate: "active" for ACTIVE_TTL_MS, "revoked" forever (it is
 * permanent). A busy cloud host therefore costs at most one primary-key lookup per isolate every
 * ACTIVE_TTL_MS, and a revoked token stops working everywhere within ACTIVE_TTL_MS (immediately in
 * the isolate that handled the destroy, which calls `markRevoked`).
 *
 * Lookup failures fail closed: the request is rejected and nothing is cached.
 */
import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { and, eq } from 'drizzle-orm'

import { db } from '../db/db'

export interface CloudHostTokenKey {
	readonly organizationId: string
	readonly userId: string
	readonly hostId: string
}

/** `null` when no cloud host row exists for the key. */
export type CloudHostRevocationLookup = (key: CloudHostTokenKey) => Promise<{ revokedAt: bigint | null } | null>

export const CLOUD_HOST_TOKEN_ACTIVE_TTL_MS = 10_000
const MAX_CACHE_ENTRIES = 10_000

export interface CloudHostTokenGate {
	isActive(key: CloudHostTokenKey): Promise<boolean>
	markRevoked(key: CloudHostTokenKey): void
}

export function makeCloudHostTokenGate(
	lookup: CloudHostRevocationLookup,
	options: { activeTtlMs?: number; now?: () => number } = {},
): CloudHostTokenGate {
	const activeTtlMs = options.activeTtlMs ?? CLOUD_HOST_TOKEN_ACTIVE_TTL_MS
	const now = options.now ?? Date.now
	// Plain values only: never cache a promise across requests (workerd forbids sharing I/O).
	const cache = new Map<string, { active: boolean; until: number }>()
	const keyOf = (key: CloudHostTokenKey) => `${key.organizationId}\u0000${key.userId}\u0000${key.hostId}`
	const remember = (key: string, entry: { active: boolean; until: number }) => {
		if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
		cache.set(key, entry)
	}

	return {
		async isActive(key) {
			const cacheKey = keyOf(key)
			const cached = cache.get(cacheKey)
			if (cached && cached.until > now()) return cached.active
			const row = await lookup(key)
			const active = row !== null && row.revokedAt === null
			remember(cacheKey, { active, until: active ? now() + activeTtlMs : Number.POSITIVE_INFINITY })
			return active
		},
		markRevoked(key) {
			remember(keyOf(key), { active: false, until: Number.POSITIVE_INFINITY })
		},
	}
}

export const lookupCloudHostRevocation: CloudHostRevocationLookup = async (key) => {
	const [row] = await db
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

let defaultGate: CloudHostTokenGate | undefined

/** The process/isolate-wide gate used by daemon auth and by `hosts.cloud.destroy`. */
export function cloudHostTokenGate(): CloudHostTokenGate {
	defaultGate ??= makeCloudHostTokenGate(lookupCloudHostRevocation)
	return defaultGate
}
