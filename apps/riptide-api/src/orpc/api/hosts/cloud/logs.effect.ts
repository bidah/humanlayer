import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { Effect } from 'effect'

import { CloudHostProvisioner } from '../../../../effects/services/cloud-hosts/cloud-host-provisioner.service'
import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'
import { cloudHostIdentity } from './cloud-host-store'

/** Recent bootstrap and daemon logs of one of the caller's cloud hosts (redacted by the provisioner). */
export const getCloudHostLogsEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.logs.effect(function* ({
	input,
	context,
	errors,
}) {
	const postgres = yield* PostgresDb
	const provisioner = yield* CloudHostProvisioner
	const key = { organizationId: context.auth.organizationId, userId: context.auth.userId, hostId: input.hostId }

	const [row] = yield* postgres
		.query(
			postgres.client
				.select({ provider: cloudHosts.provider, status: cloudHosts.status })
				.from(cloudHosts)
				.where(cloudHostIdentity(key)),
		)
		.pipe(Effect.catchTags({ PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors) }))
	if (!row) return yield* Effect.fail(errors.NOT_FOUND({ data: { message: 'Could not find that cloud host' } }))
	if (row.status === 'destroyed') {
		return yield* Effect.fail(
			errors.NOT_FOUND({ data: { message: 'This host was deleted, so its logs are gone.' } }),
		)
	}

	const logs = yield* provisioner.logs(row.provider, input.hostId, input.lines).pipe(
		Effect.catchTags({
			CloudHostProvisionerError: (error) =>
				Effect.fail(
					error.status === 404
						? errors.NOT_FOUND({ data: { message: 'The sandbox for this host no longer exists.' } })
						: errors.SERVICE_UNAVAILABLE(),
				),
		}),
	)
	return { hostId: input.hostId, ...logs }
})
