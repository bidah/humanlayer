/**
 * Stand-in for `@workos-inc/node` in the Cloudflare Worker build (aliased in wrangler.jsonc).
 *
 * The Worker never constructs the WorkOS SDK: worker/runtime.ts derives the JWKS URL itself. The
 * module is still reachable through type-bearing imports (auth/effect/workos.service.ts via
 * jwks-cache-config.service.ts), so this keeps the real SDK, and its Node dependencies, out of the
 * bundle. Only the surface that workos.service.ts touches is provided.
 */
export class WorkOS {
	readonly baseURL = 'https://api.workos.com'
	readonly userManagement = {
		getJwksUrl: (clientId: string) => `${this.baseURL}/sso/jwks/${clientId}`,
	}

	constructor(readonly key?: string) {}
}
