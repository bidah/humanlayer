import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import {
	CLOUD_HOST_STARTING_STATUSES,
	decideCloudHostAction,
	type ProvisionerView,
} from '@humanlayer/db/utils/cloud-host-lifecycle'
import { and, inArray, sql } from 'drizzle-orm'
import { Clock, Effect, Option } from 'effect'

import { CloudHostProvisioner } from '../../../../effects/services/cloud-hosts/cloud-host-provisioner.service'
import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import type { PostgresDbQueryError } from '../../../../effects/services/postgres/postgres-db.errors'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'
import { cloudHostIdentity, toCloudHostOutput, toLifecycleRow } from './cloud-host-store'

/**
 * One cloud host with its current status. While the host is starting, this asks the provisioner
 * for progress and records it (provisioning → bootstrapping, or failed), so the app can poll this
 * route instead of waiting for the reconcile pass. Readiness itself comes only from the daemon's
 * heartbeat. Provisioner errors never fail the call: the stored row is returned as is.
 */
export const getCloudHostEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.get.effect(function* ({
	input,
	context,
	errors,
}) {
	const postgres = yield* PostgresDb
	const provisioner = yield* CloudHostProvisioner
	const key = { organizationId: context.auth.organizationId, userId: context.auth.userId, hostId: input.hostId }
	const failOnDatabase = <A>(effect: Effect.Effect<A, PostgresDbQueryError>) =>
		effect.pipe(Effect.catchTags({ PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors) }))

	const [row] = yield* postgres
		.query(postgres.client.select().from(cloudHosts).where(cloudHostIdentity(key)))
		.pipe(failOnDatabase)
	if (!row) return yield* Effect.fail(errors.NOT_FOUND({ data: { message: 'Could not find that cloud host' } }))

	const starting = (CLOUD_HOST_STARTING_STATUSES as readonly string[]).includes(row.status)
	if (!starting) return { host: toCloudHostOutput(row) }

	const reported = yield* provisioner.status(row.provider, row.host_id).pipe(Effect.option)
	if (Option.isNone(reported)) return { host: toCloudHostOutput(row) }
	const info = reported

	const view: ProvisionerView =
		info.value.state === 'not_found'
			? { kind: 'absent' }
			: { kind: 'present', state: info.value.state, error: info.value.error }
	const action = decideCloudHostAction(toLifecycleRow(row), view, yield* Clock.currentTimeMillis)
	if (action.kind !== 'update') {
		return { host: toCloudHostOutput(row, { bootstrapPhase: info.value.bootstrapPhase }) }
	}

	// Guarded on the status we read, so a concurrent heartbeat (→ ready) or destroy wins.
	const [updated] = yield* postgres
		.query(
			postgres.client
				.update(cloudHosts)
				.set({
					status: action.status,
					error: action.error,
					sandbox_id: sql`coalesce(${info.value.sandboxId}, ${cloudHosts.sandbox_id})`,
				})
				.where(and(cloudHostIdentity(key), inArray(cloudHosts.status, [...CLOUD_HOST_STARTING_STATUSES])))
				.returning(),
		)
		.pipe(failOnDatabase)

	return { host: toCloudHostOutput(updated ?? row, { bootstrapPhase: info.value.bootstrapPhase }) }
})
