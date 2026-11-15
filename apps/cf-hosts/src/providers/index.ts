import type { Env } from '../env'
import type { ProviderName } from '../schemas'
import { CloudflareProvider, type CloudflareDeps } from './cloudflare'
import { DaytonaProvider } from './daytona'
import { E2BProvider } from './e2b'
import { type CloudHostProvider, type FetchLike, ProviderError } from './types'

export interface ProviderDeps {
	fetch?: FetchLike
	cloudflare?: CloudflareDeps
}

export function cloudflareDepsFromEnv(env: Env): CloudflareDeps {
	return {
		sandbox: (hostId) => env.HOST_SANDBOX.get(env.HOST_SANDBOX.idFromName(hostId)) as never,
		registry: () => env.HOST_REGISTRY.get(env.HOST_REGISTRY.idFromName('global')) as never,
	}
}

/** Whether a provider has the credentials it needs, without constructing it. */
export function providerConfigured(name: ProviderName, env: Partial<Env>): boolean {
	switch (name) {
		case 'cloudflare':
			return Boolean(env.HOST_SANDBOX && env.HOST_REGISTRY)
		case 'daytona':
			return Boolean(env.DAYTONA_API_KEY)
		case 'e2b':
			return Boolean(env.E2B_API_KEY)
	}
}

function notConfigured(name: ProviderName, what: string): ProviderError {
	return new ProviderError('not_configured', `provider "${name}" is not configured (${what} is not set)`)
}

export function selectProvider(name: ProviderName, env: Partial<Env>, deps: ProviderDeps = {}): CloudHostProvider {
	switch (name) {
		case 'cloudflare': {
			if (deps.cloudflare) return new CloudflareProvider(deps.cloudflare)
			if (!env.HOST_SANDBOX || !env.HOST_REGISTRY) throw notConfigured(name, 'HOST_SANDBOX binding')
			return new CloudflareProvider(cloudflareDepsFromEnv(env as Env))
		}
		case 'daytona': {
			const apiKey = env.DAYTONA_API_KEY
			if (!apiKey) throw notConfigured(name, 'DAYTONA_API_KEY')
			return new DaytonaProvider({
				apiKey,
				apiUrl: env.DAYTONA_API_URL || 'https://app.daytona.io/api',
				fetch: deps.fetch,
			})
		}
		case 'e2b': {
			const apiKey = env.E2B_API_KEY
			if (!apiKey) throw notConfigured(name, 'E2B_API_KEY')
			return new E2BProvider({
				apiKey,
				apiUrl: env.E2B_API_URL,
				domain: env.E2B_DOMAIN,
				template: env.E2B_TEMPLATE,
				fetch: deps.fetch,
			})
		}
	}
}
