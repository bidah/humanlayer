import type { CloudHostProvider } from '@humanlayer/db/tables/cloud-hosts'
import { CLOUD_HOST_MESSAGES, type ProvisionerHostState } from '@humanlayer/db/utils/cloud-host-lifecycle'
import { describe, expect, test } from 'vitest'

import {
	type CloudHostRow,
	type CloudHostStore,
	type ProvisionerClient,
	reconcileCloudHosts,
} from './cloud-hosts-reconcile'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const host = (hostId: string, overrides: Partial<CloudHostRow> = {}): CloudHostRow => ({
	organizationId: 'org-1',
	userId: 'user-1',
	hostId,
	provider: 'daytona',
	status: 'ready',
	error: null,
	createdAt: NOW - HOUR,
	updatedAt: NOW - HOUR,
	expiresAt: NOW + 23 * HOUR,
	...overrides,
})

/** In-memory store that records the writes the pass makes. */
function memoryStore(rows: CloudHostRow[]) {
	const writes: string[] = []
	const byId = new Map(rows.map((row) => [row.hostId, { ...row }]))
	const guard = (row: CloudHostRow) => byId.get(row.hostId)?.status === row.status
	const store: CloudHostStore = {
		loadUnsettled: async () => [...byId.values()].filter((row) => row.status !== 'destroyed'),
		update: async (row, status, error) => {
			if (!guard(row)) return false
			byId.set(row.hostId, { ...row, status, error })
			writes.push(`${row.hostId}:${status}`)
			return true
		},
		beginDestroy: async (row, reason) => {
			if (!guard(row)) return false
			byId.set(row.hostId, { ...row, status: 'destroying', error: reason ?? row.error })
			writes.push(`${row.hostId}:destroying+revoked+unregistered`)
			return true
		},
		markDestroyed: async (row, reason) => {
			if (!guard(row)) return false
			byId.set(row.hostId, { ...row, status: 'destroyed', error: reason ?? row.error })
			writes.push(`${row.hostId}:destroyed+revoked+unregistered`)
			return true
		},
	}
	return { store, writes, row: (hostId: string) => byId.get(hostId) }
}

function fakeProvisioner(options: {
	hosts?: Array<{ provider: CloudHostProvider; hostId: string }>
	failedProviders?: CloudHostProvider[]
	states?: Record<string, { state: ProvisionerHostState; error?: string }>
	destroyFails?: boolean
}) {
	const calls: string[] = []
	const client: ProvisionerClient = {
		list: async () => {
			calls.push('list')
			return { hosts: options.hosts ?? [], failedProviders: options.failedProviders ?? [] }
		},
		status: async (_provider, hostId) => {
			calls.push(`status:${hostId}`)
			const state = options.states?.[hostId]
			if (!state) throw new Error('unreachable')
			return { state: state.state, error: state.error ?? null }
		},
		destroy: async (_provider, hostId) => {
			calls.push(`destroy:${hostId}`)
			if (options.destroyFails) throw new Error('provider down')
		},
	}
	return { client, calls }
}

describe('reconcileCloudHosts', () => {
	test('does not call the provisioner when no cloud host is live', async () => {
		const { store } = memoryStore([])
		const provisioner = fakeProvisioner({})
		const summary = await reconcileCloudHosts(store, provisioner.client, () => NOW)
		expect(summary.examined).toBe(0)
		expect(provisioner.calls).toEqual([])
	})

	test('marks a host whose sandbox expired on the provisioner as destroyed and unregisters it', async () => {
		const { store, writes, row } = memoryStore([host('expired', { expiresAt: NOW - 60_000 })])
		const provisioner = fakeProvisioner({ hosts: [] })
		const summary = await reconcileCloudHosts(store, provisioner.client, () => NOW)
		expect(writes).toEqual(['expired:destroyed+revoked+unregistered'])
		expect(row('expired')?.error).toBe(CLOUD_HOST_MESSAGES.expired)
		expect(summary.destroyed).toBe(1)
		expect(provisioner.calls).toEqual(['list'])
	})

	test('asks for status only for starting hosts and records their progress or failure', async () => {
		const { store, writes, row } = memoryStore([
			host('starting', { status: 'provisioning', createdAt: NOW - 30_000 }),
			host('broken', { status: 'bootstrapping', createdAt: NOW - 60_000 }),
			host('ready'),
		])
		const provisioner = fakeProvisioner({
			hosts: [
				{ provider: 'daytona', hostId: 'starting' },
				{ provider: 'daytona', hostId: 'broken' },
				{ provider: 'daytona', hostId: 'ready' },
			],
			states: { starting: { state: 'bootstrapping' }, broken: { state: 'failed', error: 'apt-get failed' } },
		})
		await reconcileCloudHosts(store, provisioner.client, () => NOW)
		expect(provisioner.calls).toEqual(['list', 'status:starting', 'status:broken'])
		expect(writes).toEqual(['starting:bootstrapping', 'broken:failed'])
		expect(row('broken')?.error).toBe('apt-get failed')
		expect(row('ready')?.status).toBe('ready')
	})

	test('leaves hosts alone when their provider listing failed', async () => {
		const { store, writes } = memoryStore([host('a'), host('b', { provider: 'cloudflare' })])
		const provisioner = fakeProvisioner({ hosts: [], failedProviders: ['daytona'] })
		const summary = await reconcileCloudHosts(store, provisioner.client, () => NOW)
		// "b" (cloudflare) listed fine and is missing → destroyed; "a" (daytona) is untouched.
		expect(writes).toEqual(['b:destroyed+revoked+unregistered'])
		expect(summary.skippedProviders).toEqual(['daytona'])
	})

	test('destroys overdue hosts through the provisioner, and keeps them destroying when that fails', async () => {
		const overdue = host('overdue', { expiresAt: NOW - HOUR })
		const ok = memoryStore([overdue])
		await reconcileCloudHosts(
			ok.store,
			fakeProvisioner({ hosts: [{ provider: 'daytona', hostId: 'overdue' }] }).client,
			() => NOW,
		)
		expect(ok.writes).toEqual(['overdue:destroying+revoked+unregistered', 'overdue:destroyed+revoked+unregistered'])

		const failing = memoryStore([overdue])
		const summary = await reconcileCloudHosts(
			failing.store,
			fakeProvisioner({ hosts: [{ provider: 'daytona', hostId: 'overdue' }], destroyFails: true }).client,
			() => NOW,
		)
		expect(failing.writes).toEqual(['overdue:destroying+revoked+unregistered'])
		expect(failing.row('overdue')?.status).toBe('destroying')
		expect(summary.destroyRetriesPending).toBe(1)
	})

	test('retries a destroy left half-done by the API', async () => {
		const { store, writes } = memoryStore([host('half', { status: 'destroying' })])
		const provisioner = fakeProvisioner({ hosts: [{ provider: 'daytona', hostId: 'half' }] })
		await reconcileCloudHosts(store, provisioner.client, () => NOW)
		expect(provisioner.calls).toEqual(['list', 'destroy:half'])
		expect(writes).toEqual(['half:destroyed+revoked+unregistered'])
	})
})
