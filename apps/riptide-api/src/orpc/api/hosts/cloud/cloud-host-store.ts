import { agentSlashCommands } from '@humanlayer/db/tables/agent-slash-commands'
import { type CloudHost, type CloudHostStatus, cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { hostAliases } from '@humanlayer/db/tables/host-aliases'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import type { CloudHostLifecycleRow, ProvisionerHostState } from '@humanlayer/db/utils/cloud-host-lifecycle'
import type { CloudHostOutput } from '@humanlayer/riptide-api-contract/api/hosts/cloud'
import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'

import type { PostgresTransaction } from '../../../../effects/services/postgres/postgres-db.service'

export interface CloudHostKey {
	readonly organizationId: string
	readonly userId: string
	readonly hostId: string
}

export const cloudHostIdentity = (key: CloudHostKey) =>
	and(
		eq(cloudHosts.organization_id, key.organizationId),
		eq(cloudHosts.user_id, key.userId),
		eq(cloudHosts.host_id, key.hostId),
	)

const toMillis = (value: bigint | null): number | null => (value === null ? null : Number(value))

export function toCloudHostOutput(row: CloudHost, extra: { bootstrapPhase?: string | null } = {}): CloudHostOutput {
	const output: CloudHostOutput = {
		hostId: row.host_id,
		provider: row.provider,
		status: row.status,
		error: row.error,
		size: row.size,
		ttlMinutes: row.ttl_minutes,
		createdAt: Number(row.created_at),
		expiresAt: toMillis(row.expires_at),
		readyAt: toMillis(row.ready_at),
		destroyedAt: toMillis(row.destroyed_at),
	}
	if (extra.bootstrapPhase !== undefined) output.bootstrapPhase = extra.bootstrapPhase
	return output
}

export function toLifecycleRow(row: CloudHost): CloudHostLifecycleRow {
	return {
		status: row.status,
		error: row.error,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		expiresAt: toMillis(row.expires_at),
	}
}

/** Row status for the state the provisioner reports right after `create`. */
export function statusAfterCreate(state: ProvisionerHostState): CloudHostStatus {
	switch (state) {
		case 'provisioning':
			return 'provisioning'
		case 'failed':
			return 'failed'
		default:
			return 'bootstrapping'
	}
}

export function parseIsoMillis(value: string | null | undefined): bigint | null {
	if (!value) return null
	const millis = Date.parse(value)
	return Number.isFinite(millis) ? BigInt(millis) : null
}

/**
 * Remove the host's daemon registration so the app stops offering it: the `online_hosts` row and
 * what hangs off it (alias, slash commands), exactly what the sweeper removes for expired hosts.
 */
export const deleteHostRegistration = (tx: PostgresTransaction, key: CloudHostKey) =>
	Effect.gen(function* () {
		for (const table of [onlineHosts, hostAliases, agentSlashCommands] as const) {
			yield* tx.query(
				tx.client
					.delete(table)
					.where(
						and(
							eq(table.host_id, key.hostId),
							eq(table.organization_id, key.organizationId),
							eq(table.user_id, key.userId),
						),
					),
			)
		}
	})
