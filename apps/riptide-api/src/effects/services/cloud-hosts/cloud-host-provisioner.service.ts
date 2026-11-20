/**
 * Client for the cloud host provisioner (`human-flare-hosts`, apps/cf-hosts). Its README is the
 * contract this codes against.
 *
 * Transport, chosen per call:
 * - Cloudflare Worker with a `HOSTS` service binding: requests go through the binding (no public
 *   hop). They are still addressed to `CLOUD_HOSTS_URL` (the provisioner's public origin), because
 *   the provisioner tells each new host to download the CLI from the origin it was called on.
 * - Otherwise (Node/AWS, or a Worker without the binding): `CLOUD_HOSTS_URL` over public fetch.
 * - Neither: the provisioner is "not configured" and every call fails with `not_configured`.
 *
 * Every `/v1` call carries `Authorization: Bearer <INTERNAL_SERVICE_SECRET>`. Request bodies (they
 * hold the daemon token and the user's agent credentials) are never logged or put in errors.
 */
import type { CloudHostProvider, CloudHostSize } from '@humanlayer/db/tables/cloud-hosts'
import type { ProvisionerHostState } from '@humanlayer/db/utils/cloud-host-lifecycle'
import { Config, Context, Data, Effect, Layer, Option, Redacted } from 'effect'

import { getOptionalWorkerEnv } from '../../../platform/worker-env'

const BINDING_ORIGIN = 'https://human-flare-hosts.internal'
const REQUEST_TIMEOUT_MS = 120_000

export interface ProvisionerHostInfo {
	provider: CloudHostProvider
	hostId: string
	sandboxId: string | null
	state: ProvisionerHostState
	providerState: string | null
	bootstrapPhase: string | null
	daemonRunning: boolean | null
	error: string | null
	createdAt: string | null
	expiresAt: string | null
	size: CloudHostSize | null
}

export interface ProvisionerCreateInput {
	provider: CloudHostProvider
	hostId: string
	daemonToken: string
	env: Record<string, string>
	ttlMinutes: number
	size?: CloudHostSize
	labels?: Record<string, string>
}

/**
 * `status` is the provisioner's HTTP status (0 when it could not be reached); `code` its error
 * code (`not_configured`, `invalid_request`, `provider_error`, `timeout`, ...). `message` comes
 * from the provisioner, which redacts secrets before responding.
 */
export class CloudHostProvisionerError extends Data.TaggedError('CloudHostProvisionerError')<{
	readonly status: number
	readonly code: string
	readonly message: string
}> {}

export interface CloudHostProvisionerApi {
	/** Which providers this deployment can create hosts on. Never fails; unreachable = none. */
	readonly providers: () => Effect.Effect<Record<CloudHostProvider, boolean>>
	readonly create: (
		input: ProvisionerCreateInput,
	) => Effect.Effect<{ created: boolean; host: ProvisionerHostInfo }, CloudHostProvisionerError>
	/** A missing host is returned with `state: 'not_found'`, not as an error. */
	readonly status: (
		provider: CloudHostProvider,
		hostId: string,
	) => Effect.Effect<ProvisionerHostInfo, CloudHostProvisionerError>
	readonly logs: (
		provider: CloudHostProvider,
		hostId: string,
		lines: number,
	) => Effect.Effect<{ bootstrap: string; daemon: string }, CloudHostProvisionerError>
	/** Idempotent: `destroyed: false` when there was nothing to destroy. */
	readonly destroy: (
		provider: CloudHostProvider,
		hostId: string,
	) => Effect.Effect<{ destroyed: boolean }, CloudHostProvisionerError>
}

export class CloudHostProvisioner extends Context.Service<CloudHostProvisioner, CloudHostProvisionerApi>()(
	'CloudHostProvisioner',
) {}

type Transport = { fetch: (request: Request) => Promise<Response>; origin: string }

interface ProvisionerSettings {
	/** Public URL fallback for runtimes without the `HOSTS` binding (Node/AWS). */
	readonly url: Option.Option<string>
	readonly secret: Option.Option<Redacted.Redacted<string>>
}

/** The binding is looked up per call: the Worker env is installed per request by the entry. */
function resolveTransport(settings: ProvisionerSettings): Transport | null {
	const url = Option.getOrUndefined(settings.url)?.trim().replace(/\/+$/, '')
	const binding = getOptionalWorkerEnv()?.HOSTS
	// Through the binding the hostname is not resolved, but the provisioner sees it: it builds the
	// CLI download URL for the bootstrap from its request origin, so use the public origin when known.
	if (binding) return { fetch: (request) => binding.fetch(request), origin: url || BINDING_ORIGIN }
	if (url) return { fetch: (request) => fetch(request), origin: url }
	return null
}

const notConfigured = () =>
	new CloudHostProvisionerError({ status: 501, code: 'not_configured', message: 'Cloud hosts are not configured' })

/** Parsed JSON body, or null when the body is empty or not JSON. */
type ProvisionerResponse = { status: number; body: Record<string, unknown> | null }

function parseBody(text: string): Record<string, unknown> | null {
	if (!text) return null
	try {
		const parsed: Record<string, unknown> | null = JSON.parse(text)
		return parsed
	} catch {
		return null
	}
}

function makeCall(settings: ProvisionerSettings) {
	return (
		method: string,
		path: string,
		body?: unknown,
	): Effect.Effect<ProvisionerResponse, CloudHostProvisionerError> =>
		Effect.gen(function* () {
			const transport = resolveTransport(settings)
			const secret = Option.getOrUndefined(settings.secret)
			if (!transport || !secret) return yield* Effect.fail(notConfigured())
			const headers = new Headers({ authorization: `Bearer ${Redacted.value(secret)}` })
			if (body !== undefined) headers.set('content-type', 'application/json')
			return yield* Effect.tryPromise({
				try: async (signal) => {
					const request = new Request(`${transport.origin}${path}`, {
						method,
						headers,
						body: body === undefined ? undefined : JSON.stringify(body),
						signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
					})
					const response = await transport.fetch(request)
					return { status: response.status, body: parseBody(await response.text()) }
				},
				// Never include the request (token, credentials) in the error.
				catch: (cause) =>
					new CloudHostProvisionerError({
						status: 0,
						code: 'unreachable',
						message: cause instanceof Error ? cause.name : 'request failed',
					}),
			})
		})
}

function toError(response: ProvisionerResponse): CloudHostProvisionerError {
	const error = response.body?.error as { code?: unknown; message?: unknown } | undefined
	return new CloudHostProvisionerError({
		status: response.status,
		code: typeof error?.code === 'string' ? error.code : 'provider_error',
		message: typeof error?.message === 'string' ? error.message.slice(0, 500) : `HTTP ${response.status}`,
	})
}

const hostPath = (provider: CloudHostProvider, hostId: string) =>
	`/v1/hosts/${encodeURIComponent(provider)}/${encodeURIComponent(hostId)}`

const NO_PROVIDERS: Record<CloudHostProvider, boolean> = { cloudflare: false, daytona: false, e2b: false }

export const CloudHostProvisionerLive = Layer.effect(
	CloudHostProvisioner,
	Effect.gen(function* () {
		const settings: ProvisionerSettings = {
			url: yield* Config.option(Config.String('CLOUD_HOSTS_URL')),
			secret: yield* Config.option(Config.Redacted('INTERNAL_SERVICE_SECRET')),
		}
		const call = makeCall(settings)
		return CloudHostProvisioner.of({
			providers: () =>
				Effect.gen(function* () {
					const response = yield* call('GET', '/health')
					if (response.status !== 200) return NO_PROVIDERS
					const providers = (response.body?.providers as Record<string, unknown> | undefined) ?? {}
					return {
						cloudflare: providers.cloudflare === true,
						daytona: providers.daytona === true,
						e2b: providers.e2b === true,
					}
				}).pipe(Effect.orElseSucceed(() => NO_PROVIDERS)),
			create: (input) =>
				call('POST', '/v1/hosts', input).pipe(
					Effect.flatMap((response) => {
						const host = response.body?.host as ProvisionerHostInfo | undefined
						if ((response.status !== 200 && response.status !== 201) || !host)
							return Effect.fail(toError(response))
						return Effect.succeed({ created: response.body?.created === true, host })
					}),
				),
			status: (provider, hostId) =>
				call('GET', hostPath(provider, hostId)).pipe(
					Effect.flatMap((response) => {
						const host = response.body?.host as ProvisionerHostInfo | undefined
						if ((response.status === 200 || response.status === 404) && host) return Effect.succeed(host)
						return Effect.fail(toError(response))
					}),
				),
			logs: (provider, hostId, lines) =>
				call('GET', `${hostPath(provider, hostId)}/logs?lines=${lines}`).pipe(
					Effect.flatMap((response) => {
						if (response.status !== 200) return Effect.fail(toError(response))
						const bootstrap = response.body?.bootstrap
						const daemon = response.body?.daemon
						return Effect.succeed({
							bootstrap: typeof bootstrap === 'string' ? bootstrap : '',
							daemon: typeof daemon === 'string' ? daemon : '',
						})
					}),
				),
			destroy: (provider, hostId) =>
				call('DELETE', hostPath(provider, hostId)).pipe(
					Effect.flatMap((response) =>
						response.status === 200 || response.status === 404
							? Effect.succeed({ destroyed: response.status === 200 })
							: Effect.fail(toError(response)),
					),
				),
		})
	}),
)
