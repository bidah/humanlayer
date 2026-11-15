/**
 * Cloud host reconcile pass: converge `cloud_hosts` with what the provisioner (`humanlayer-hosts`)
 * actually runs. Runs every minute after the stale-daemon sweeper.
 *
 * The decision per host is `decideCloudHostAction` (@humanlayer/db/utils/cloud-host-lifecycle),
 * shared with the API. This module only gathers the provisioner's view and applies the action:
 * - hosts whose sandbox disappeared (provisioner TTL, provider-side deletion) → destroyed;
 * - hosts stuck coming up, or whose bootstrap failed → failed;
 * - `destroying` hosts (a destroy whose provisioner call failed) → delete retried;
 * - hosts past their expiry, or failed for an hour → destroyed through the provisioner.
 * Every host leaving the live set has its daemon token revoked and its `online_hosts`
 * registration (with alias and slash commands) removed, so the app stops offering it.
 *
 * Cost: one indexed query per run (`cloud_hosts_unsettled_created_at_idx`); when no host is live,
 * the provisioner is not called at all. Otherwise one provisioner list call, plus one status call
 * per host that is still starting.
 */
import { cloudHosts, type CloudHost, type CloudHostProvider } from '@humanlayer/db/tables/cloud-hosts'
import {
	type CloudHostAction,
	decideCloudHostAction,
	type ProvisionerHostState,
	type ProvisionerView,
} from '@humanlayer/db/utils/cloud-host-lifecycle'
import { deleteHostRegistrations } from '@humanlayer/stale-daemon-sweeper/expired-hosts'
import type { Database } from '@humanlayer/stale-daemon-sweeper/stale-daemons'
import { and, asc, eq, ne, sql } from 'drizzle-orm'

const BATCH_LIMIT = 500

export interface ProvisionerClient {
	/** `failedProviders`: providers whose listing failed; their hosts are left alone this run. */
	list(): Promise<{
		hosts: Array<{ provider: CloudHostProvider; hostId: string }>
		failedProviders: CloudHostProvider[]
	}>
	status(provider: CloudHostProvider, hostId: string): Promise<{ state: ProvisionerHostState; error: string | null }>
	/** Idempotent; resolves when the sandbox is gone (or never existed). */
	destroy(provider: CloudHostProvider, hostId: string): Promise<void>
}

export interface CloudHostRow {
	organizationId: string
	userId: string
	hostId: string
	provider: CloudHostProvider
	status: CloudHost['status']
	error: string | null
	createdAt: number
	updatedAt: number
	expiresAt: number | null
}

/** Storage seam, so the orchestration is unit-testable without Postgres. */
export interface CloudHostStore {
	loadUnsettled(): Promise<CloudHostRow[]>
	/** Each write is guarded on the status the decision was made from; false if it changed. */
	update(row: CloudHostRow, status: CloudHost['status'], error: string | null): Promise<boolean>
	/** status → destroying, token revoked, registration removed. */
	beginDestroy(row: CloudHostRow, reason: string | null): Promise<boolean>
	/** status → destroyed (token revoked if not yet), registration removed. */
	markDestroyed(row: CloudHostRow, reason: string | null): Promise<boolean>
}

export interface ReconcileSummary {
	examined: number
	updated: number
	destroyed: number
	destroyRetriesPending: number
	skippedProviders: CloudHostProvider[]
}

const isStarting = (status: CloudHost['status']) => status === 'provisioning' || status === 'bootstrapping'

export async function reconcileCloudHosts(
	store: CloudHostStore,
	provisioner: ProvisionerClient,
	now: () => number = Date.now,
): Promise<ReconcileSummary> {
	const summary: ReconcileSummary = {
		examined: 0,
		updated: 0,
		destroyed: 0,
		destroyRetriesPending: 0,
		skippedProviders: [],
	}
	const rows = await store.loadUnsettled()
	if (rows.length === 0) return summary

	const listing = await provisioner.list()
	const failed = new Set(listing.failedProviders)
	summary.skippedProviders = [...failed]
	const present = new Set(listing.hosts.map((host) => `${host.provider}:${host.hostId}`))

	for (const row of rows) {
		summary.examined += 1
		let view: ProvisionerView
		if (failed.has(row.provider)) view = { kind: 'unknown' }
		else if (!present.has(`${row.provider}:${row.hostId}`)) view = { kind: 'absent' }
		else if (isStarting(row.status)) {
			try {
				const status = await provisioner.status(row.provider, row.hostId)
				view = { kind: 'present', state: status.state, error: status.error }
			} catch {
				view = { kind: 'present' }
			}
		} else view = { kind: 'present' }

		const action: CloudHostAction = decideCloudHostAction(row, view, now())
		switch (action.kind) {
			case 'none':
				break
			case 'update':
				if (await store.update(row, action.status, action.error)) summary.updated += 1
				break
			case 'markDestroyed':
				if (await store.markDestroyed(row, action.reason)) summary.destroyed += 1
				break
			case 'destroy': {
				if (row.status !== 'destroying' && !(await store.beginDestroy(row, action.reason))) break
				const destroying = { ...row, status: 'destroying' as const }
				try {
					await provisioner.destroy(row.provider, row.hostId)
				} catch {
					summary.destroyRetriesPending += 1
					break
				}
				if (await store.markDestroyed(destroying, action.reason)) summary.destroyed += 1
				break
			}
		}
	}
	return summary
}

// ---------------------------------------------------------------------------------------- store

const identity = (row: CloudHostRow) =>
	and(
		eq(cloudHosts.organization_id, row.organizationId),
		eq(cloudHosts.user_id, row.userId),
		eq(cloudHosts.host_id, row.hostId),
		eq(cloudHosts.status, row.status),
	)

const registrationKey = (row: CloudHostRow) => ({
	hostId: row.hostId,
	organizationId: row.organizationId,
	userId: row.userId,
})

export function makeDrizzleCloudHostStore(db: Database): CloudHostStore {
	return {
		async loadUnsettled() {
			const rows = await db
				.select()
				.from(cloudHosts)
				.where(ne(cloudHosts.status, 'destroyed'))
				.orderBy(asc(cloudHosts.created_at))
				.limit(BATCH_LIMIT)
			return rows.map((row) => ({
				organizationId: row.organization_id,
				userId: row.user_id,
				hostId: row.host_id,
				provider: row.provider,
				status: row.status,
				error: row.error,
				createdAt: Number(row.created_at),
				updatedAt: Number(row.updated_at),
				expiresAt: row.expires_at === null ? null : Number(row.expires_at),
			}))
		},
		async update(row, status, error) {
			const updated = await db
				.update(cloudHosts)
				.set({ status, error })
				.where(identity(row))
				.returning({ hostId: cloudHosts.host_id })
			return updated.length > 0
		},
		async beginDestroy(row, reason) {
			return db.transaction(async (tx) => {
				const updated = await tx
					.update(cloudHosts)
					.set({
						status: 'destroying',
						error: reason ?? row.error,
						revoked_at: sql`coalesce(${cloudHosts.revoked_at}, ${BigInt(Date.now())})`,
					})
					.where(identity(row))
					.returning({ hostId: cloudHosts.host_id })
				if (updated.length === 0) return false
				await deleteHostRegistrations(tx, [registrationKey(row)])
				return true
			})
		},
		async markDestroyed(row, reason) {
			return db.transaction(async (tx) => {
				const now = BigInt(Date.now())
				const updated = await tx
					.update(cloudHosts)
					.set({
						status: 'destroyed',
						error: reason ?? row.error,
						destroyed_at: now,
						revoked_at: sql`coalesce(${cloudHosts.revoked_at}, ${now})`,
					})
					.where(identity(row))
					.returning({ hostId: cloudHosts.host_id })
				if (updated.length === 0) return false
				await deleteHostRegistrations(tx, [registrationKey(row)])
				return true
			})
		},
	}
}

// ----------------------------------------------------------------------------------- provisioner

export interface ProvisionerBindingEnv {
	HOSTS?: Fetcher
	INTERNAL_SERVICE_SECRET?: string
}

class ProvisionerHttpError extends Error {}

/** Provisioner client over the `HOSTS` service binding (apps/cf-hosts README is the contract). */
export function makeBindingProvisionerClient(env: ProvisionerBindingEnv): ProvisionerClient | null {
	const binding = env.HOSTS
	const secret = env.INTERNAL_SERVICE_SECRET
	if (!binding || !secret) return null
	const call = async (method: string, path: string) => {
		// Read-only/destroy calls only; unlike create, the origin of these requests is never used by the provisioner.
		const response = await binding.fetch(`https://humanlayer-hosts.internal${path}`, {
			method,
			headers: { authorization: `Bearer ${secret}` },
		})
		const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
		return { status: response.status, body }
	}
	const hostPath = (provider: string, hostId: string) =>
		`/v1/hosts/${encodeURIComponent(provider)}/${encodeURIComponent(hostId)}`
	return {
		async list() {
			const { status, body } = await call('GET', '/v1/hosts')
			if (status !== 200 || !body) throw new ProvisionerHttpError(`list failed: HTTP ${status}`)
			const hosts = (body.hosts as Array<{ provider: CloudHostProvider; hostId: string }> | undefined) ?? []
			const errors = (body.errors as Array<{ provider: CloudHostProvider }> | undefined) ?? []
			return { hosts, failedProviders: errors.map((error) => error.provider) }
		},
		async status(provider, hostId) {
			const { status, body } = await call('GET', hostPath(provider, hostId))
			const host = body?.host as { state: ProvisionerHostState; error: string | null } | undefined
			if ((status !== 200 && status !== 404) || !host)
				throw new ProvisionerHttpError(`status failed: HTTP ${status}`)
			return { state: host.state, error: host.error }
		},
		async destroy(provider, hostId) {
			const { status } = await call('DELETE', hostPath(provider, hostId))
			if (status !== 200 && status !== 404) throw new ProvisionerHttpError(`destroy failed: HTTP ${status}`)
		},
	}
}
