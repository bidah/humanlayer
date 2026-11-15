import { WorkOS } from '@workos-inc/node'
import { Config, Context, Effect, Layer, Option, Redacted } from 'effect'

import { EnvironmentVariable } from '@/lib/effect/environment'

/**
 * Define the Workos Config Services used for creating other services that depend on workos stuf
 */
export class WorkosConfig extends Context.Service<
	WorkosConfig,
	{
		workosClientId: string
		workosRedirectUri: string
		workos: WorkOS
		jwksUrl: string
	}
>()('WorkosConfig') {}

/**
 * This is the workos layer which implements the service definition WorkosConfig
 * distinct e.g. from WorkosConfigTest  - this is the correct effect idiom
 */
export const WorkosConfigLive = Layer.effect(
	WorkosConfig,
	Effect.gen(function* () {
		// do effectful things to build it
		const workosClientId = yield* EnvironmentVariable('WORKOS_CLIENT_ID')
		const workosRedirectUri = yield* EnvironmentVariable('WORKOS_REDIRECT_URI')
		const workosApiKey = yield* EnvironmentVariable('WORKOS_API_KEY').pipe(Effect.map(Redacted.make))

		// Optional override of the WorkOS API host, so the SDK can target a WorkOS-compatible service
		// (for example the self-hosted `humanlayer-auth` Worker). Unset = api.workos.com, as upstream.
		const apiHostname = Option.getOrUndefined(yield* Config.option(Config.String('WORKOS_API_HOSTNAME')))
		const apiHttps = Option.getOrUndefined(yield* Config.option(Config.String('WORKOS_API_HTTPS')))
		const apiPort = Option.getOrUndefined(yield* Config.option(Config.String('WORKOS_API_PORT')))
		const clientOptions: { apiHostname?: string; https?: boolean; port?: number } = {}
		if (apiHostname) {
			clientOptions.apiHostname = apiHostname
			clientOptions.https = apiHttps !== 'false'
			if (apiPort) clientOptions.port = Number(apiPort)
		}

		const workos = new WorkOS(Redacted.value(workosApiKey), clientOptions)

		return {
			workosClientId,
			workosRedirectUri,
			workos,
			jwksUrl: workos.userManagement.getJwksUrl(workosClientId),
		}
	}),
)
