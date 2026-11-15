import { randomUUID } from 'node:crypto'

import { cloudHosts } from '@humanlayer/db/tables/cloud-hosts'
import { hostAliases } from '@humanlayer/db/tables/host-aliases'
import { onlineHosts } from '@humanlayer/db/tables/online-hosts'
import { organizations } from '@humanlayer/db/tables/organizations'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { Effect, Layer } from 'effect'
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import {
	CloudHostProvisioner,
	CloudHostProvisionerError,
	type ProvisionerCreateInput,
	type ProvisionerHostInfo,
} from '../../src/effects/services/cloud-hosts/cloud-host-provisioner.service'
import { createCloudHostEffectProcedure as liveCreate } from '../../src/orpc/api/hosts/cloud/create.effect'
import { destroyCloudHostEffectProcedure as liveDestroy } from '../../src/orpc/api/hosts/cloud/destroy.effect'
import { getCloudHostEffectProcedure as liveGet } from '../../src/orpc/api/hosts/cloud/get.effect'
import { listCloudHostsEffectProcedure as liveList } from '../../src/orpc/api/hosts/cloud/list.effect'
import { getCloudHostLogsEffectProcedure as liveLogs } from '../../src/orpc/api/hosts/cloud/logs.effect'
import { listCloudHostProvidersEffectProcedure as liveProviders } from '../../src/orpc/api/hosts/cloud/providers.effect'
import { heartbeatEffectProcedure as liveHeartbeat } from '../../src/orpc/daemon/hosts/heartbeat.effect'
import { createMockApiAuth, createMockApiContext, createMockDaemonAuth, createMockDaemonContext } from '../mocks'
import { createRuntimeWithTestPostgresLayer } from '../utils/effect-procedure-test-runtime'
import { requireExternalTestServices } from '../utils/external-test-services'
import { createTestDb } from '../utils/test-db'

await requireExternalTestServices()

const SECRET_KEY = 'sk-ant-api03-test-secret-value'
const SECRET_GH = 'ghp_test_secret_value'

/** Scriptable fake provisioner that records every call. */
class FakeProvisioner {
	calls: string[] = []
	creates: ProvisionerCreateInput[] = []
	createFailure: CloudHostProvisionerError | null = null
	destroyFailure: CloudHostProvisionerError | null = null
	statusState: ProvisionerHostInfo['state'] = 'bootstrapping'
	statusError: string | null = null

	info(hostId: string, state: ProvisionerHostInfo['state']): ProvisionerHostInfo {
		return {
			provider: 'daytona',
			hostId,
			sandboxId: `sbx-${hostId.slice(0, 8)}`,
			state,
			providerState: 'started',
			bootstrapPhase: state === 'bootstrapping' ? 'cli' : null,
			daemonRunning: null,
			error: state === 'failed' ? this.statusError : null,
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
			size: 'medium',
		}
	}

	layer() {
		return Layer.succeed(CloudHostProvisioner, {
			providers: () => Effect.succeed({ cloudflare: true, daytona: true, e2b: false }),
			create: (input) =>
				Effect.suspend(() => {
					this.calls.push(`create:${input.provider}`)
					this.creates.push(input)
					return this.createFailure
						? Effect.fail(this.createFailure)
						: Effect.succeed({ created: true, host: this.info(input.hostId, 'bootstrapping') })
				}),
			status: (_provider, hostId) =>
				Effect.sync(() => {
					this.calls.push(`status:${hostId}`)
					return this.info(hostId, this.statusState)
				}),
			logs: (_provider, hostId) =>
				Effect.sync(() => {
					this.calls.push(`logs:${hostId}`)
					return { bootstrap: '[bootstrap] phase=daemon', daemon: '[supervisor] starting daemon' }
				}),
			destroy: (_provider, hostId) =>
				Effect.suspend(() => {
					this.calls.push(`destroy:${hostId}`)
					return this.destroyFailure ? Effect.fail(this.destroyFailure) : Effect.succeed({ destroyed: true })
				}),
		})
	}
}

describe('api/hosts/cloud', async () => {
	let cleanupTestDb: (() => Promise<void>) | undefined
	let db: PostgresJsDatabase
	let runtime: ReturnType<typeof createRuntimeWithTestPostgresLayer> | undefined
	let organizationId: string
	const provisioner = new FakeProvisioner()
	const userId = 'user_cloud_hosts'
	const otherUserId = 'user_cloud_hosts_other'

	const procedures = () => {
		if (!runtime) throw new Error('runtime not ready')
		return {
			create: liveCreate.withRuntime(runtime),
			list: liveList.withRuntime(runtime),
			get: liveGet.withRuntime(runtime),
			logs: liveLogs.withRuntime(runtime),
			destroy: liveDestroy.withRuntime(runtime),
			providers: liveProviders.withRuntime(runtime),
			heartbeat: liveHeartbeat.withRuntime(runtime),
		}
	}

	beforeAll(async () => {
		const testDb = await createTestDb('hosts_cloud')
		cleanupTestDb = testDb.cleanup
		db = testDb.db
		runtime = createRuntimeWithTestPostgresLayer(db, { cloudHostProvisioner: provisioner.layer() })
		const [organization] = await db
			.insert(organizations)
			.values({ name: 'Cloud Host Org', workos_organization_id: `org_${randomUUID()}` })
			.returning()
		organizationId = organization!.id
		if (!process.env.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY) {
			const { privateKey } = await generateKeyPair('RS256', { extractable: true })
			process.env.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY = Buffer.from(await exportPKCS8(privateKey)).toString('base64')
		}
	}, 60_000)

	afterAll(async () => {
		await runtime?.dispose()
		await cleanupTestDb?.()
	}, 30_000)

	beforeEach(async () => {
		provisioner.calls = []
		provisioner.creates = []
		provisioner.createFailure = null
		provisioner.destroyFailure = null
		provisioner.statusState = 'bootstrapping'
		await db.delete(cloudHosts)
		await db.delete(onlineHosts)
	})

	const api = (asUser = userId) => ({
		context: createMockApiContext({
			auth: createMockApiAuth({ userId: asUser, organizationId, workosOrganizationId: 'org_cloud' }),
			services: { db, dbReadReplica: db },
		}),
	})
	const daemon = (hostId: string, cloudHost?: boolean) => ({
		context: createMockDaemonContext({
			auth: createMockDaemonAuth({ hostId, organizationId, userId, ...(cloudHost ? { cloudHost } : {}) }),
			services: { db, dbReadReplica: db },
		}),
	})
	const selectRow = async (hostId: string) => {
		const [row] = await db.select().from(cloudHosts).where(eq(cloudHosts.host_id, hostId))
		return row
	}
	const selectOnline = async (hostId: string) =>
		db
			.select()
			.from(onlineHosts)
			.where(and(eq(onlineHosts.host_id, hostId), eq(onlineHosts.organization_id, organizationId)))
	const heartbeatInput = (hostId: string) => ({ hostId, hostName: 'cloud-host', daemonVersion: '1.0.0' })

	test('providers reports what the provisioner has credentials for', async () => {
		const result = await call(procedures().providers, {}, api())
		expect(result).toEqual({
			providers: [
				{ provider: 'cloudflare', available: true },
				{ provider: 'daytona', available: true },
				{ provider: 'e2b', available: false },
			],
			defaultProvider: 'cloudflare',
		})
	})

	test('create writes the row first, mints a revocable token for the caller, and never stores credentials', async () => {
		const result = await call(
			procedures().create,
			{
				provider: 'daytona',
				ttlMinutes: 60,
				credentials: { anthropicApiKey: SECRET_KEY, githubToken: SECRET_GH },
			},
			api(),
		)

		expect(result.host).toMatchObject({
			provider: 'daytona',
			status: 'bootstrapping',
			size: 'medium',
			ttlMinutes: 60,
		})
		const [sent] = provisioner.creates
		expect(sent?.hostId).toBe(result.host.hostId)
		expect(sent?.env).toEqual({ ANTHROPIC_API_KEY: SECRET_KEY, GH_TOKEN: SECRET_GH })
		expect(decodeJwt(sent!.daemonToken)).toMatchObject({
			userId,
			organizationId,
			hostId: result.host.hostId,
			cloudHost: true,
		})

		const row = await selectRow(result.host.hostId)
		expect(row).toMatchObject({ status: 'bootstrapping', user_id: userId, revoked_at: null })
		expect(row?.sandbox_id).toBe(`sbx-${result.host.hostId.slice(0, 8)}`)
		const stored = JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
		expect(stored).not.toContain(SECRET_KEY)
		expect(stored).not.toContain(SECRET_GH)
	})

	test('a failed create deletes any half-created sandbox and revokes the token', async () => {
		provisioner.createFailure = new CloudHostProvisionerError({
			status: 502,
			code: 'provider_error',
			message: 'boom',
		})

		await expect(call(procedures().create, { provider: 'daytona' }, api())).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		})

		const hostId = provisioner.creates[0]!.hostId
		expect(provisioner.calls).toEqual(['create:daytona', `destroy:${hostId}`])
		const row = await selectRow(hostId)
		expect(row?.status).toBe('destroyed')
		expect(row?.revoked_at).not.toBeNull()
	})

	test('a provider without credentials is a BAD_REQUEST, and the row is left destroyed', async () => {
		provisioner.createFailure = new CloudHostProvisionerError({
			status: 501,
			code: 'not_configured',
			message: 'E2B_API_KEY is not set',
		})
		await expect(call(procedures().create, { provider: 'e2b' }, api())).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		})
		expect((await selectRow(provisioner.creates[0]!.hostId))?.status).toBe('destroyed')
	})

	test('E2B hosts are capped at 24 hours by the contract', async () => {
		await expect(call(procedures().create, { provider: 'e2b', ttlMinutes: 48 * 60 }, api())).rejects.toBeDefined()
		expect(provisioner.calls).toEqual([])
	})

	test('a member may hold at most 5 live cloud hosts', async () => {
		for (let index = 0; index < 5; index++) await call(procedures().create, { provider: 'cloudflare' }, api())
		await expect(call(procedures().create, { provider: 'cloudflare' }, api())).rejects.toMatchObject({
			code: 'BAD_REQUEST',
		})
		expect(provisioner.creates).toHaveLength(5)
	})

	test('list, get and logs are scoped to the caller', async () => {
		const { host } = await call(procedures().create, { provider: 'daytona' }, api())

		expect((await call(procedures().list, {}, api())).hosts.map((h) => h.hostId)).toEqual([host.hostId])
		expect((await call(procedures().list, {}, api(otherUserId))).hosts).toEqual([])
		await expect(call(procedures().get, { hostId: host.hostId }, api(otherUserId))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
		await expect(call(procedures().logs, { hostId: host.hostId }, api(otherUserId))).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})

		const logs = await call(procedures().logs, { hostId: host.hostId }, api())
		expect(logs).toEqual({
			hostId: host.hostId,
			bootstrap: '[bootstrap] phase=daemon',
			daemon: '[supervisor] starting daemon',
		})
	})

	test('get records provisioner progress while the host starts, including a bootstrap failure', async () => {
		const { host } = await call(procedures().create, { provider: 'daytona' }, api())
		await db.update(cloudHosts).set({ status: 'provisioning' }).where(eq(cloudHosts.host_id, host.hostId))

		provisioner.statusState = 'running'
		expect((await call(procedures().get, { hostId: host.hostId }, api())).host.status).toBe('bootstrapping')

		provisioner.statusState = 'failed'
		provisioner.statusError = 'npm install failed'
		const failed = await call(procedures().get, { hostId: host.hostId }, api())
		expect(failed.host).toMatchObject({ status: 'failed', error: 'npm install failed' })
		expect((await selectRow(host.hostId))?.status).toBe('failed')
	})

	test('the first heartbeat of a cloud host marks it ready; ordinary heartbeats never touch cloud_hosts', async () => {
		const { host } = await call(procedures().create, { provider: 'daytona' }, api())

		await call(procedures().heartbeat, heartbeatInput(host.hostId), daemon(host.hostId, true))
		const row = await selectRow(host.hostId)
		expect(row?.status).toBe('ready')
		expect(row?.ready_at).not.toBeNull()
		expect(await selectOnline(host.hostId)).toHaveLength(1)

		const ordinary = randomUUID()
		await call(procedures().heartbeat, heartbeatInput(ordinary), daemon(ordinary))
		expect(await selectOnline(ordinary)).toHaveLength(1)
		expect(await selectRow(ordinary)).toBeUndefined()
	})

	test('destroy revokes the token, removes the registration, and the host cannot re-register', async () => {
		const { host } = await call(procedures().create, { provider: 'daytona' }, api())
		await call(procedures().heartbeat, heartbeatInput(host.hostId), daemon(host.hostId, true))
		await db
			.insert(hostAliases)
			.values({ host_id: host.hostId, user_id: userId, organization_id: organizationId, display_name: 'cloud' })

		const result = await call(procedures().destroy, { hostId: host.hostId }, api())

		expect(result.host.status).toBe('destroyed')
		expect(provisioner.calls).toContain(`destroy:${host.hostId}`)
		const row = await selectRow(host.hostId)
		expect(row?.revoked_at).not.toBeNull()
		expect(row?.destroyed_at).not.toBeNull()
		expect(await selectOnline(host.hostId)).toEqual([])
		expect(await db.select().from(hostAliases).where(eq(hostAliases.host_id, host.hostId))).toEqual([])
		expect((await call(procedures().list, {}, api())).hosts).toEqual([])

		await expect(
			call(procedures().heartbeat, heartbeatInput(host.hostId), daemon(host.hostId, true)),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
		expect(await selectOnline(host.hostId)).toEqual([])

		// Idempotent.
		expect((await call(procedures().destroy, { hostId: host.hostId }, api())).host.status).toBe('destroyed')
	})

	test('when the provisioner cannot delete, the host stays destroying (revoked) for the reconcile pass', async () => {
		const { host } = await call(procedures().create, { provider: 'daytona' }, api())
		provisioner.destroyFailure = new CloudHostProvisionerError({
			status: 0,
			code: 'unreachable',
			message: 'TypeError',
		})

		const result = await call(procedures().destroy, { hostId: host.hostId }, api())

		expect(result.host.status).toBe('destroying')
		expect((await selectRow(host.hostId))?.revoked_at).not.toBeNull()
		await expect(call(procedures().destroy, { hostId: randomUUID() }, api())).rejects.toMatchObject({
			code: 'NOT_FOUND',
		})
	})
})
