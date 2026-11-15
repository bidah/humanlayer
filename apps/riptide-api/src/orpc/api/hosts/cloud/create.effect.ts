import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { CLOUD_HOST_MESSAGES } from '@humanlayer/db/utils/cloud-host-lifecycle'
import { and, count, eq, ne, sql } from 'drizzle-orm'
import { Clock, Effect } from 'effect'

import { cloudHostTokenGate } from '../../../../auth/cloud-host-revocation'
import { createSignedCloudHostDaemonToken } from '../../../../auth/daemon-tokens'
import {
	CloudHostProvisioner,
	type ProvisionerCreateInput,
} from '../../../../effects/services/cloud-hosts/cloud-host-provisioner.service'
import { mapPostgresErrorToResponse } from '../../../../effects/services/postgres/error-mapping'
import type { PostgresDbQueryError } from '../../../../effects/services/postgres/postgres-db.errors'
import { PostgresDb } from '../../../../effects/services/postgres/postgres-db.service'
import { effectOrpcBaseOrganizationRequired, requiresBillingEffectMiddleware } from '../../../effect-base'
import { cloudHostIdentity, parseIsoMillis, statusAfterCreate, toCloudHostOutput } from './cloud-host-store'

/** Live (not destroyed) cloud hosts one member may hold in one organization. */
export const MAX_CLOUD_HOSTS_PER_USER = 5

/**
 * Agent credentials → the env the provisioner writes to the host. They exist only in this request:
 * never stored, never logged, never part of an error.
 */
function credentialsEnv(
	credentials: {
		anthropicApiKey?: string
		claudeCodeOauthToken?: string
		githubToken?: string
	} = {},
): Record<string, string> {
	const env: Record<string, string> = {}
	if (credentials.anthropicApiKey) env.ANTHROPIC_API_KEY = credentials.anthropicApiKey
	if (credentials.claudeCodeOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = credentials.claudeCodeOauthToken
	if (credentials.githubToken) env.GH_TOKEN = credentials.githubToken
	return env
}

/**
 * Create a cloud host: choose the host id, mint its (revocable) daemon token, write the row, then
 * ask the provisioner for a sandbox. The row exists before the token leaves the API, so the
 * token is never valid without a row that can revoke it. If the provisioner call fails, any
 * half-created sandbox is deleted (apps/cf-hosts README) and the token is revoked.
 */
export const createCloudHostEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.create
	.use(requiresBillingEffectMiddleware)
	.effect(function* ({ input, context, errors }) {
		const postgres = yield* PostgresDb
		const provisioner = yield* CloudHostProvisioner
		const { userId, organizationId } = context.auth
		const failOnDatabase = <A>(effect: Effect.Effect<A, PostgresDbQueryError>) =>
			effect.pipe(
				Effect.catchTags({ PostgresDbQueryError: (error) => mapPostgresErrorToResponse(error, errors) }),
			)

		const [live] = yield* postgres
			.query(
				postgres.client
					.select({ count: count() })
					.from(cloudHosts)
					.where(
						and(
							eq(cloudHosts.organization_id, organizationId),
							eq(cloudHosts.user_id, userId),
							ne(cloudHosts.status, 'destroyed'),
						),
					),
			)
			.pipe(failOnDatabase)
		if ((live?.count ?? 0) >= MAX_CLOUD_HOSTS_PER_USER) {
			return yield* Effect.fail(
				errors.BAD_REQUEST({
					data: {
						message: `You have ${MAX_CLOUD_HOSTS_PER_USER} cloud hosts. Delete one to create another.`,
					},
				}),
			)
		}

		const hostId = crypto.randomUUID()
		const key = { organizationId, userId, hostId }
		const provider = input.provider
		const size = provider === 'daytona' ? (input.size ?? 'medium') : null
		const createdAt = yield* Clock.currentTimeMillis

		const daemonToken = yield* Effect.tryPromise({
			try: () => createSignedCloudHostDaemonToken(userId, organizationId, hostId, createdAt),
			catch: () => errors.INTERNAL_SERVER_ERROR(),
		})

		yield* postgres
			.query(
				postgres.client.insert(cloudHosts).values({
					organization_id: organizationId,
					user_id: userId,
					host_id: hostId,
					provider,
					status: 'provisioning',
					size,
					ttl_minutes: input.ttlMinutes,
					expires_at: BigInt(createdAt + input.ttlMinutes * 60_000),
					created_at: BigInt(createdAt),
					updated_at: BigInt(createdAt),
				}),
			)
			.pipe(failOnDatabase)

		const request: ProvisionerCreateInput = {
			provider,
			hostId,
			daemonToken,
			env: credentialsEnv(input.credentials),
			ttlMinutes: input.ttlMinutes,
			labels: { orgId: organizationId },
		}
		if (size) request.size = size
		const created = yield* provisioner.create(request).pipe(
			Effect.catchTags({
				CloudHostProvisionerError: (error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning('Cloud host create failed').pipe(
							Effect.annotateLogs({ hostId, provider, status: error.status, code: error.code }),
						)
						// A sandbox may exist after a failed create; DELETE is safe either way.
						const cleaned = yield* provisioner
							.destroy(provider, hostId)
							.pipe(
								Effect.as(true),
								Effect.catchTags({ CloudHostProvisionerError: () => Effect.succeed(false) }),
							)
						const now = BigInt(yield* Clock.currentTimeMillis)
						cloudHostTokenGate().markRevoked(key)
						yield* postgres
							.query(
								postgres.client
									.update(cloudHosts)
									.set({
										// Not cleaned: the reconcile pass retries the delete.
										status: cleaned ? 'destroyed' : 'destroying',
										error: CLOUD_HOST_MESSAGES.provisionerFailed,
										revoked_at: now,
										destroyed_at: cleaned ? now : null,
									})
									.where(cloudHostIdentity(key)),
							)
							.pipe(failOnDatabase)
						if (error.code === 'not_configured') {
							return yield* Effect.fail(
								errors.BAD_REQUEST({
									data: { message: 'This provider is not available on this deployment.' },
								}),
							)
						}
						if (error.status >= 400 && error.status < 500) {
							return yield* Effect.fail(errors.BAD_REQUEST({ data: { message: error.message } }))
						}
						return yield* Effect.fail(errors.SERVICE_UNAVAILABLE())
					}),
			}),
		)

		const status = statusAfterCreate(created.host.state)
		const [row] = yield* postgres
			.query(
				postgres.client
					.update(cloudHosts)
					.set({
						// A heartbeat may already have marked the host ready; never move it back.
						status: sql`case when ${cloudHosts.status} = 'provisioning' then ${status} else ${cloudHosts.status} end`,
						error: sql`case when ${cloudHosts.status} = 'provisioning' then ${
							status === 'failed' ? (created.host.error ?? CLOUD_HOST_MESSAGES.bootstrapFailed) : null
						}::text else ${cloudHosts.error} end`,
						sandbox_id: created.host.sandboxId,
						expires_at:
							parseIsoMillis(created.host.expiresAt) ?? BigInt(createdAt + input.ttlMinutes * 60_000),
					})
					.where(cloudHostIdentity(key))
					.returning(),
			)
			.pipe(failOnDatabase)
		if (!row) return yield* Effect.fail(errors.INTERNAL_SERVER_ERROR())

		yield* Effect.logInfo('Cloud host created').pipe(
			Effect.annotateLogs({ hostId, provider, organizationId, status: row.status }),
		)
		return { host: toCloudHostOutput(row, { bootstrapPhase: created.host.bootstrapPhase }) }
	})
