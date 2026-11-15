import { CloudHostProviderSchema } from '@humanlayer/db/tables/cloud-hosts'

import { CloudHostProvisioner } from '../../../../effects/services/cloud-hosts/cloud-host-provisioner.service'
import { effectOrpcBaseOrganizationRequired } from '../../../effect-base'

/** Which providers this deployment can create cloud hosts on, as the provisioner reports it. */
export const listCloudHostProvidersEffectProcedure = effectOrpcBaseOrganizationRequired.hosts.cloud.providers.effect(
	function* () {
		const provisioner = yield* CloudHostProvisioner
		const available = yield* provisioner.providers()
		return {
			providers: CloudHostProviderSchema.options.map((provider) => ({
				provider,
				available: available[provider],
			})),
			defaultProvider: 'cloudflare' as const,
		}
	},
)
