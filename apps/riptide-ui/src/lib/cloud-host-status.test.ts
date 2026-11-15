import { describe, expect, it } from 'vitest'

import {
	canReadCloudHostLogs,
	describeCloudHostError,
	describeCloudHostExpiry,
	isCloudHostSettling,
	ttlOptionsFor,
} from './cloud-host-status'

describe('cloud host presentation', () => {
	it('polls only while a host is changing on its own', () => {
		expect(isCloudHostSettling('provisioning')).toBe(true)
		expect(isCloudHostSettling('bootstrapping')).toBe(true)
		expect(isCloudHostSettling('destroying')).toBe(true)
		expect(isCloudHostSettling('ready')).toBe(false)
		expect(isCloudHostSettling('failed')).toBe(false)
	})

	it('offers logs only while a sandbox exists', () => {
		expect(canReadCloudHostLogs('failed')).toBe(true)
		expect(canReadCloudHostLogs('destroyed')).toBe(false)
	})

	it('caps E2B at 24 hours', () => {
		expect(ttlOptionsFor('e2b').map((option) => option.minutes)).toEqual([60, 240, 1440])
		expect(ttlOptionsFor('daytona').map((option) => option.minutes)).toContain(7 * 24 * 60)
	})

	it('describes expiry in relative terms', () => {
		expect(describeCloudHostExpiry(null, 0)).toBeNull()
		expect(describeCloudHostExpiry(0, 1)).toBe('Expired')
		expect(describeCloudHostExpiry(12 * 60_000, 0)).toBe('Expires in 12 min')
		expect(describeCloudHostExpiry(3 * 3_600_000, 0)).toBe('Expires in 3 h')
		expect(describeCloudHostExpiry(7 * 24 * 3_600_000, 0)).toBe('Expires in 7 days')
	})

	it('uses the server message for a rejected request and a fixed one otherwise', () => {
		expect(
			describeCloudHostError({ code: 'BAD_REQUEST', data: { message: 'You have 5 cloud hosts.' } }, 'fallback'),
		).toBe('You have 5 cloud hosts.')
		expect(describeCloudHostError({ code: 'SERVICE_UNAVAILABLE' }, 'fallback')).toBe(
			'The cloud provider did not respond. Try again in a minute.',
		)
		expect(describeCloudHostError(new Error('raw'), 'fallback')).toBe('fallback')
	})
})
