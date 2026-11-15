import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { and, eq, sql } from 'drizzle-orm'
import { Clock, Effect } from 'effect'

import { cloudHostTokenGate } from '../../../../auth/cloud-host-revocation'
import { CloudHostProvisioner } from '../../../../effects/services/cloud-hosts/cloud-host-provisioner.service'
import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'
import { cloudHostIdentity, deleteHostRegistration, toCloudHostOutput } from './cloud-host-store'

/**
 * Destroy a cloud host. In order:
 * 1. one transaction: status → destroying, `revoked_at` set (the daemon token is rejected from
 *    now on), and the host registration (`online_hosts`, alias, slash commands) removed;
 * 2. the provisioner deletes the sandbox;
 * 3. status → destroyed, and the registration removed again in case a heartbeat that was already
 *    in flight re-created it.
 * If step 2 fails the host stays `destroying` (still revoked) and the reconcile pass in
 * apps/cf-jobs retries it. Destroying a destroyed host returns it unchanged.
 *
 * Not behind the billing gate (unlike create): stopping a paid sandbox must always be possible.
 */
export const destroyCloudHostEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.destroy.effect(
	function* ({ input, context, errors }) {
		const postgres = yield* PostgresDb
		const provisioner = yield* CloudHostProvisioner
		const key = { organizationId: context.auth.organizationId, userId: context.auth.userId, hostId: input.hostId }
		const mapDatabaseError = (error: Parameters<typeof mapPostgresErrorToResponse>[0]) =>
			mapPostgresErrorToResponse(error, errors)

		const revoked = yield* postgres
			.transaction((tx) =>
				Effect.gen(function* () {
					const [row] = yield* tx.query(
						tx.client.select().from(cloudHosts).where(cloudHostIdentity(key)).for('update'),
					)
					if (!row || row.status === 'destroyed') return row ?? null
					const now = BigInt(yield* Clock.currentTimeMillis)
					const [updated] = yield* tx.query(
						tx.client
							.update(cloudHosts)
							.set({
								status: 'destroying',
								revoked_at: sql`coalesce(${cloudHosts.revoked_at}, ${now})`,
							})
							.where(cloudHostIdentity(key))
							.returning(),
					)
					yield* deleteHostRegistration(tx, key)
					return updated ?? null
				}),
			)
			.pipe(
				Effect.catchTags({
					PostgresDbQueryError: mapDatabaseError,
					PostgresDbTransactionError: mapDatabaseError,
				}),
			)
		if (!revoked)
			return yield* Effect.fail(errors.NOT_FOUND({ data: { message: 'Could not find that cloud host' } }))
		if (revoked.status === 'destroyed') return { host: toCloudHostOutput(revoked) }
		cloudHostTokenGate().markRevoked(key)

		const deleted = yield* provisioner.destroy(revoked.provider, revoked.host_id).pipe(
			Effect.as(true),
			Effect.catchTags({
				CloudHostProvisionerError: (error) =>
					Effect.logWarning('Cloud host destroy failed; the reconcile pass will retry').pipe(
						Effect.annotateLogs({
							hostId: key.hostId,
							provider: revoked.provider,
							status: error.status,
							code: error.code,
						}),
						Effect.as(false),
					),
			}),
		)
		if (!deleted) return { host: toCloudHostOutput(revoked) }

		const destroyedAt = BigInt(yield* Clock.currentTimeMillis)
		const destroyed = yield* postgres
			.transaction((tx) =>
				Effect.gen(function* () {
					const [row] = yield* tx.query(
						tx.client
							.update(cloudHosts)
							.set({ status: 'destroyed', destroyed_at: destroyedAt })
							.where(and(cloudHostIdentity(key), eq(cloudHosts.status, 'destroying')))
							.returning(),
					)
					yield* deleteHostRegistration(tx, key)
					return row
				}),
			)
			.pipe(
				Effect.catchTags({
					PostgresDbQueryError: mapDatabaseError,
					PostgresDbTransactionError: mapDatabaseError,
				}),
			)

		yield* Effect.logInfo('Cloud host destroyed').pipe(
			Effect.annotateLogs({ hostId: key.hostId, provider: revoked.provider, organizationId: key.organizationId }),
		)
		return { host: toCloudHostOutput(destroyed ?? revoked) }
	},
)
