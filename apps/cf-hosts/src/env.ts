import type { HostRegistry } from './cloudflare/host-registry'
import type { HostSandbox } from './cloudflare/host-sandbox'

export interface Env {
	HOST_SANDBOX: DurableObjectNamespace<HostSandbox>
	HOST_REGISTRY: DurableObjectNamespace<HostRegistry>
	ARTIFACTS: R2Bucket
	INTERNAL_SERVICE_SECRET?: string
	DAYTONA_API_KEY?: string
	DAYTONA_API_URL?: string
	E2B_API_KEY?: string
	E2B_API_URL?: string
	E2B_DOMAIN?: string
	/** E2B template id; defaults to `base` (small). */
	E2B_TEMPLATE?: string
	CLOUDFLARE_INSTANCE_TYPE?: string
}
