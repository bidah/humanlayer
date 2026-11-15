import { describe, expect, test } from 'vitest'

import {
	CLOUD_HOST_CREATE_GRACE_MS,
	CLOUD_HOST_EXPIRY_SLACK_MS,
	CLOUD_HOST_FAILED_RETENTION_MS,
	CLOUD_HOST_MESSAGES,
	CLOUD_HOST_PROVISIONING_TIMEOUT_MS,
	type CloudHostLifecycleRow,
	decideCloudHostAction,
} from '../src/utils/cloud-host-lifecycle'

const NOW = 1_800_000_000_000

const row = (overrides: Partial<CloudHostLifecycleRow> = {}): CloudHostLifecycleRow => ({
	status: 'provisioning',
	error: null,
	createdAt: NOW - 60_000,
	updatedAt: NOW - 60_000,
	expiresAt: NOW + 24 * 3_600_000,
	...overrides,
})

describe('decideCloudHostAction', () => {
	test('never touches destroyed rows or rows the provisioner could not report on', () => {
		expect(decideCloudHostAction(row({ status: 'destroyed' }), { kind: 'absent' }, NOW)).toEqual({ kind: 'none' })
		expect(decideCloudHostAction(row({ status: 'ready' }), { kind: 'unknown' }, NOW)).toEqual({ kind: 'none' })
	})

	test('advances a starting host from the provisioner state, but never to ready', () => {
		expect(decideCloudHostAction(row(), { kind: 'present', state: 'bootstrapping' }, NOW)).toEqual({
			kind: 'update',
			status: 'bootstrapping',
			error: null,
		})
		expect(decideCloudHostAction(row(), { kind: 'present', state: 'running' }, NOW)).toEqual({
			kind: 'update',
			status: 'bootstrapping',
			error: null,
		})
		expect(
			decideCloudHostAction(row({ status: 'bootstrapping' }), { kind: 'present', state: 'running' }, NOW),
		).toEqual({ kind: 'none' })
		// Never backwards.
		expect(
			decideCloudHostAction(row({ status: 'bootstrapping' }), { kind: 'present', state: 'provisioning' }, NOW),
		).toEqual({ kind: 'none' })
	})

	test('marks a bootstrap failure failed with the provisioner error', () => {
		expect(
			decideCloudHostAction(
				row({ status: 'bootstrapping' }),
				{ kind: 'present', state: 'failed', error: 'apt failed' },
				NOW,
			),
		).toEqual({ kind: 'update', status: 'failed', error: 'apt failed' })
		expect(decideCloudHostAction(row(), { kind: 'present', state: 'failed', error: null }, NOW)).toEqual({
			kind: 'update',
			status: 'failed',
			error: CLOUD_HOST_MESSAGES.bootstrapFailed,
		})
	})

	test('fails a host that has not come online within the timeout', () => {
		const stuck = row({ status: 'bootstrapping', createdAt: NOW - CLOUD_HOST_PROVISIONING_TIMEOUT_MS })
		expect(decideCloudHostAction(stuck, { kind: 'present', state: 'running' }, NOW)).toEqual({
			kind: 'update',
			status: 'failed',
			error: CLOUD_HOST_MESSAGES.timeout,
		})
	})

	test('a missing sandbox is fine during the create grace period, then the host is destroyed', () => {
		expect(decideCloudHostAction(row(), { kind: 'absent' }, NOW)).toEqual({ kind: 'none' })
		const old = row({ createdAt: NOW - CLOUD_HOST_CREATE_GRACE_MS })
		expect(decideCloudHostAction(old, { kind: 'absent' }, NOW)).toEqual({
			kind: 'markDestroyed',
			reason: CLOUD_HOST_MESSAGES.gone,
		})
		expect(decideCloudHostAction(row({ status: 'ready' }), { kind: 'present', state: 'not_found' }, NOW)).toEqual({
			kind: 'markDestroyed',
			reason: CLOUD_HOST_MESSAGES.gone,
		})
	})

	test('a ready host whose sandbox expired is marked destroyed with the expiry reason', () => {
		const expired = row({ status: 'ready', expiresAt: NOW - 1 })
		expect(decideCloudHostAction(expired, { kind: 'absent' }, NOW)).toEqual({
			kind: 'markDestroyed',
			reason: CLOUD_HOST_MESSAGES.expired,
		})
	})

	test('destroys a host the provisioner failed to expire', () => {
		const overdue = row({ status: 'ready', expiresAt: NOW - CLOUD_HOST_EXPIRY_SLACK_MS })
		expect(decideCloudHostAction(overdue, { kind: 'present' }, NOW)).toEqual({
			kind: 'destroy',
			reason: CLOUD_HOST_MESSAGES.expired,
		})
		expect(decideCloudHostAction(row({ status: 'ready', expiresAt: NOW - 1 }), { kind: 'present' }, NOW)).toEqual({
			kind: 'none',
		})
	})

	test('keeps a failed host for its logs, then destroys it', () => {
		const failed = row({ status: 'failed', error: 'boom', updatedAt: NOW - 60_000 })
		expect(decideCloudHostAction(failed, { kind: 'present' }, NOW)).toEqual({ kind: 'none' })
		const longFailed = { ...failed, updatedAt: NOW - CLOUD_HOST_FAILED_RETENTION_MS }
		expect(decideCloudHostAction(longFailed, { kind: 'present' }, NOW)).toEqual({ kind: 'destroy', reason: 'boom' })
	})

	test('retries a destroy that did not reach the provisioner, and settles once the sandbox is gone', () => {
		const destroying = row({ status: 'destroying' })
		expect(decideCloudHostAction(destroying, { kind: 'present' }, NOW)).toEqual({ kind: 'destroy', reason: null })
		expect(decideCloudHostAction(destroying, { kind: 'absent' }, NOW)).toEqual({
			kind: 'markDestroyed',
			reason: null,
		})
		expect(decideCloudHostAction(destroying, { kind: 'present', state: 'destroying' }, NOW)).toEqual({
			kind: 'markDestroyed',
			reason: null,
		})
	})

	test('leaves a healthy ready host alone', () => {
		expect(decideCloudHostAction(row({ status: 'ready' }), { kind: 'present' }, NOW)).toEqual({ kind: 'none' })
	})
})
