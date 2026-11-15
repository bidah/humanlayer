/**
 * The cloud host state machine, shared by the API (create, get, destroy, daemon heartbeat) and the
 * reconcile pass in apps/cf-jobs. Pure: no I/O, so both runtimes apply exactly the same rules.
 *
 * Transitions and where they happen:
 * - (none) → provisioning: API `hosts.cloud.create` inserts the row before calling the provisioner.
 * - provisioning → bootstrapping: API create, once the provisioner reports the sandbox is up; also
 *   `hosts.cloud.get` and the reconcile pass from the provisioner's status.
 * - provisioning|bootstrapping|failed → ready: the daemon's first accepted heartbeat
 *   (daemon `hosts.heartbeat`). Readiness means "HumanLayer can reach the daemon", not "the
 *   sandbox is up", so only a heartbeat sets it.
 * - provisioning|bootstrapping → failed: API create when the provisioner call fails; get/reconcile
 *   when the provisioner reports a bootstrap failure, or after PROVISIONING_TIMEOUT_MS.
 * - any live status → destroying: API `hosts.cloud.destroy` (also revokes the daemon token and
 *   removes the host registration), or the reconcile pass for expired / long-failed hosts.
 * - destroying → destroyed: once the provisioner confirms the sandbox is gone (destroy, or the
 *   reconcile pass retrying it). A live row whose sandbox disappeared (the provisioner's TTL, a
 *   provider-side deletion) goes straight to destroyed in the reconcile pass.
 */
import type { CloudHostStatus } from '../tables/cloud-hosts'

/** Statuses whose daemon token is still accepted. */
export const CLOUD_HOST_LIVE_STATUSES = ['provisioning', 'bootstrapping', 'ready', 'failed'] as const
/** Statuses the API is still waiting on the provisioner for. */
export const CLOUD_HOST_STARTING_STATUSES = ['provisioning', 'bootstrapping'] as const

/** A host that has not heartbeated this long after creation is marked failed. */
export const CLOUD_HOST_PROVISIONING_TIMEOUT_MS = 15 * 60 * 1000
/** A row may exist before its sandbox does (the row is written before the provisioner call). */
export const CLOUD_HOST_CREATE_GRACE_MS = 3 * 60 * 1000
/** Failed hosts keep their sandbox this long so their logs can be read, then they are destroyed. */
export const CLOUD_HOST_FAILED_RETENTION_MS = 60 * 60 * 1000
/** The provisioner destroys hosts at `expires_at`; after this much slack the reconcile pass does. */
export const CLOUD_HOST_EXPIRY_SLACK_MS = 10 * 60 * 1000

export const CLOUD_HOST_MESSAGES = {
	timeout: 'The daemon did not come online within 15 minutes. Read the logs, then delete this host.',
	bootstrapFailed: 'Setup failed on the host. Read the logs, then delete this host.',
	expired: 'This host reached its time limit and was removed.',
	gone: 'The sandbox no longer exists.',
	failedCleanup: 'Removed an hour after setup failed.',
	provisionerFailed: 'Could not start the sandbox.',
} as const

/** Coarse provisioner state (apps/cf-hosts README, `HostState`). */
export type ProvisionerHostState =
	| 'provisioning'
	| 'bootstrapping'
	| 'running'
	| 'degraded'
	| 'failed'
	| 'stopped'
	| 'destroying'
	| 'not_found'

export interface CloudHostLifecycleRow {
	status: CloudHostStatus
	error: string | null
	createdAt: number
	updatedAt: number
	expiresAt: number | null
}

/**
 * What the provisioner knows about a host:
 * - `unknown`: the provisioner could not be asked (provider listing failed); change nothing.
 * - `absent`: the provisioner has no sandbox for this host.
 * - `present`: it has one; `state` is set when a status call was made (only for hosts coming up).
 */
export type ProvisionerView =
	| { kind: 'unknown' }
	| { kind: 'absent' }
	| { kind: 'present'; state?: ProvisionerHostState; error?: string | null }

export type CloudHostAction =
	| { kind: 'none' }
	| { kind: 'update'; status: 'provisioning' | 'bootstrapping' | 'failed'; error: string | null }
	/** Ask the provisioner to delete the sandbox, then mark the row destroyed. */
	| { kind: 'destroy'; reason: string | null }
	/** Nothing to delete any more: mark the row destroyed and revoke its token. */
	| { kind: 'markDestroyed'; reason: string | null }

const isStarting = (status: CloudHostStatus) => status === 'provisioning' || status === 'bootstrapping'

function update(
	row: CloudHostLifecycleRow,
	status: 'provisioning' | 'bootstrapping' | 'failed',
	error: string | null,
): CloudHostAction {
	return row.status === status && row.error === error ? { kind: 'none' } : { kind: 'update', status, error }
}

/** Decide how a row converges with what the provisioner reports. */
export function decideCloudHostAction(row: CloudHostLifecycleRow, view: ProvisionerView, now: number): CloudHostAction {
	if (row.status === 'destroyed') return { kind: 'none' }
	if (view.kind === 'unknown') return { kind: 'none' }

	if (row.status === 'destroying') {
		return view.kind === 'absent' || view.state === 'not_found' || view.state === 'destroying'
			? { kind: 'markDestroyed', reason: row.error }
			: { kind: 'destroy', reason: row.error }
	}

	const age = now - row.createdAt
	const expired = row.expiresAt !== null && now >= row.expiresAt

	if (view.kind === 'absent' || view.state === 'not_found') {
		if (row.status === 'provisioning' && age < CLOUD_HOST_CREATE_GRACE_MS) return { kind: 'none' }
		return { kind: 'markDestroyed', reason: expired ? CLOUD_HOST_MESSAGES.expired : CLOUD_HOST_MESSAGES.gone }
	}

	if (row.expiresAt !== null && now >= row.expiresAt + CLOUD_HOST_EXPIRY_SLACK_MS) {
		return { kind: 'destroy', reason: CLOUD_HOST_MESSAGES.expired }
	}
	if (row.status === 'failed') {
		return now - row.updatedAt >= CLOUD_HOST_FAILED_RETENTION_MS
			? { kind: 'destroy', reason: row.error ?? CLOUD_HOST_MESSAGES.failedCleanup }
			: { kind: 'none' }
	}
	if (!isStarting(row.status)) return { kind: 'none' }

	if (view.state === 'failed') return update(row, 'failed', view.error || CLOUD_HOST_MESSAGES.bootstrapFailed)
	if (age >= CLOUD_HOST_PROVISIONING_TIMEOUT_MS) return update(row, 'failed', CLOUD_HOST_MESSAGES.timeout)
	switch (view.state) {
		case 'provisioning':
			// Never move backwards: a re-bootstrapping sandbox stays "bootstrapping".
			return row.status === 'bootstrapping' ? { kind: 'none' } : update(row, 'provisioning', null)
		case 'bootstrapping':
		case 'running':
		case 'degraded':
			return update(row, 'bootstrapping', null)
		default:
			return { kind: 'none' }
	}
}
