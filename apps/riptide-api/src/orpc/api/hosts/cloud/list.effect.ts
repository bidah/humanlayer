import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { and, desc, eq, ne } from 'drizzle-orm'
import { Effect } from 'effect'

import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'
import { toCloudHostOutput } from './cloud-host-store'

/** The caller's cloud hosts in this organization that are not destroyed, newest first. */
export const listCloudHostsEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.list.effect(function* ({
	context,
	errors,
}) {
	const postgres = yield* PostgresDb
	const { userId, organizationId } = context.auth

	const rows = yield* postgres
		.query(
			postgres.client
				.select()
				.from(cloudHosts)
				.where(
					and(
						eq(cloudHosts.organization_id, organizationId),
						eq(cloudHosts.user_id, userId),
						ne(cloudHosts.status, 'destroyed'),
					),
				)
				.orderBy(desc(cloudHosts.created_at)),
		)
		.pipe(Effect.catchTags({ PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors) }))

	return { hosts: rows.map((row) => toCloudHostOutput(row)) }
})
