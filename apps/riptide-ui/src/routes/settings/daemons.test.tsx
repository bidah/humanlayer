import { describe, expect, it, vi } from 'vitest'

import { Route } from './daemons'

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: object) => options,
}))
vi.mock('@/components/settings/DaemonsSettingsSection', () => ({ DaemonsSettingsSection: () => null }))

const route = Route as unknown as { validateSearch: (search: Record<string, unknown>) => { newCloudHost?: true } }

describe('/settings/daemons', () => {
	it('opens the new cloud host dialog only for newCloudHost=true', () => {
		expect(route.validateSearch({ newCloudHost: 'true' })).toEqual({ newCloudHost: true })
		expect(route.validateSearch({ newCloudHost: true })).toEqual({ newCloudHost: true })
		expect(route.validateSearch({ newCloudHost: 'yes' })).toEqual({})
		expect(route.validateSearch({})).toEqual({})
	})
})
