import { createFileRoute } from '@tanstack/react-router'

import { DaemonsSettingsSection } from '@/components/settings/DaemonsSettingsSection'

export const Route = createFileRoute('/settings/daemons')({
	// `?newCloudHost=true` opens the "New cloud host" dialog (the launcher's host picker links here).
	validateSearch: (search: Record<string, unknown>): { newCloudHost?: true } =>
		search.newCloudHost === true || search.newCloudHost === 'true' ? { newCloudHost: true } : {},
	component: DaemonsSettingsRoute,
})

function DaemonsSettingsRoute() {
	return <DaemonsSettingsSection />
}
