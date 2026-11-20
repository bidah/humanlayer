/**
 * human-flare-electric: Electric SQL (docker.io/electricsql/electric) as a singleton Cloudflare
 * Container, fronted by a Worker that forwards every request to the container's port 3000.
 *
 * Reachable only through a service binding (wrangler.jsonc has `workers_dev: false` and no
 * routes). human-flare-sync (riptide-electric-proxy) is the only intended caller; it appends the
 * Electric `secret` query parameter itself.
 *
 * Reference: .claude/skills/self-host-humanlayer/references/pulumi-infra/electric-sql/pulumi.ts
 */
import { Container } from '@cloudflare/containers'

/**
 * How long the container keeps running after the last request finishes.
 *
 * Tradeoff:
 * - Electric's disk is ephemeral on Cloudflare Containers, so every stop throws away the shape
 *   cache. The next start re-reads every requested shape from Postgres and connected clients get
 *   `409 must-refetch` and download their shapes again. A cold start also adds an image pull from
 *   Docker Hub (Cloudflare does not cache third-party registry images), the BEAM boot, and the
 *   replication connection: tens of seconds before the first shape answers.
 * - Memory and disk are billed for as long as the container runs (CPU only when busy). While
 *   Electric is awake it also holds a replication connection open, which keeps the Neon compute
 *   from auto-suspending.
 *
 * Long-polls (`live=true`, held ~20 s by Electric) count as in-flight requests, so any connected
 * daemon or open browser tab keeps the container awake on its own; this timeout only decides how
 * long an *unused* deployment keeps paying. 30 minutes rides over short gaps (a laptop lid closed
 * over lunch does not cost a full resync) while letting an idle night shut everything down.
 * Use e.g. '24h' for effectively always-on, or '5m' to minimise cost.
 */
const ELECTRIC_IDLE_TIMEOUT = '30m'

/** Exactly one Electric may exist: it holds the replication slot and an advisory lock. */
const ELECTRIC_INSTANCE_NAME = 'electric-singleton'
const ELECTRIC_PORT = 3000
/** How long a request that arrives during a cold start waits for Electric to report `active`. */
const READY_DEADLINE_MS = 120_000
const HEALTH_POLL_INTERVAL_MS = 500
/** How often, and how far apart, a 503 from Electric is retried before it is passed on. */
const UNAVAILABLE_RETRIES = 4
const UNAVAILABLE_RETRY_DELAY_MS = 2_000
/** Header that must carry INTERNAL_SERVICE_SECRET when the Worker is reached over workers.dev. */
const PUBLIC_ACCESS_HEADER = 'x-humanlayer-internal-secret'

interface Env {
	ELECTRIC: DurableObjectNamespace<ElectricContainer>
	/** Direct (non-pooled) Neon URL. Logical replication needs a real session: never Hyperdrive or a pooler. */
	DATABASE_URL: string
	ELECTRIC_SECRET: string
	/** Only used to guard temporary workers.dev exposure during debugging. */
	INTERNAL_SERVICE_SECRET?: string
}

/**
 * Container env, modelled on the reference Fargate task (dev stage: 2 vCPU / 4 GiB, pool 20,
 * 5000 shapes) scaled to the instance type chosen in wrangler.jsonc. Honeycomb/OTEL and Sentry are
 * left out on purpose.
 */
function electricEnvironment(env: Env) {
	return {
		DATABASE_URL: env.DATABASE_URL,
		ELECTRIC_SECRET: env.ELECTRIC_SECRET,
		ELECTRIC_PORT: String(ELECTRIC_PORT),
		ELECTRIC_LOG_COLORS: 'false',
		// Above Cloudflare's own proxy idle limits so keep-alive sockets are not cut mid-poll.
		ELECTRIC_TCP_READ_TIMEOUT: '120s',
		ELECTRIC_DB_POOL_SIZE: '10',
		ELECTRIC_MAX_SHAPES: '1000',
		ELECTRIC_MAX_CONCURRENT_REQUESTS: '{"initial": 300, "existing": 5000}',
		// BEAM binary-memory GC tuning the reference applies to 1.7.x (refc-binary retention OOM).
		ELECTRIC_TWEAKS_HANDLER_FULLSWEEP_AFTER: '10',
		ELECTRIC_SHAPE_SUSPEND_CONSUMER: 'true',
		// The disk is ephemeral, so a persistent slot buys nothing: a restart rebuilds every shape
		// anyway. A persistent slot would instead make Neon retain WAL for as long as the container
		// sleeps. A temporary slot is dropped when Electric's replication session ends.
		CLEANUP_REPLICATION_SLOTS_ON_SHUTDOWN: 'true',
		ELECTRIC_USAGE_REPORTING: 'false',
	}
}

export class ElectricContainer extends Container<Env> {
	override defaultPort = ELECTRIC_PORT
	override sleepAfter = ELECTRIC_IDLE_TIMEOUT
	override enableInternet = true
	// Any HTTP answer on this path means the port is open; readiness is checked separately below.
	override pingEndpoint = 'localhost/v1/health'

	private ready: Promise<void> | undefined

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env)
		this.envVars = electricEnvironment(env)
	}

	override onStart(): void {
		console.log({ event: 'electric_container_started' })
	}

	override onStop(params: { exitCode: number; reason: string }): void {
		this.ready = undefined
		console.log({ event: 'electric_container_stopped', ...params })
	}

	override onError(error: unknown): unknown {
		this.ready = undefined
		console.error({ event: 'electric_container_error', error: String(error) })
		throw error
	}

	override async fetch(request: Request): Promise<Response> {
		try {
			await this.waitUntilActive()
		} catch (error) {
			return new Response(
				`Electric is not available: ${error instanceof Error ? error.message : String(error)}`,
				{
					status: 503,
					headers: { 'retry-after': '5' },
				},
			)
		}
		// Right after a cold start Electric can answer the first shape requests with 503 while its
		// first snapshot waits on a table lock ("Snapshot timed out while waiting for a table lock").
		// Shape requests are reads, so retry here a few times instead of surfacing every cold start
		// to clients. The request body (small subset queries only) is buffered so it can be resent.
		const body = request.body ? await request.arrayBuffer() : undefined
		const send = () =>
			this.containerFetch(
				new Request(request.url, {
					method: request.method,
					headers: request.headers,
					body: body && body.byteLength > 0 ? body : undefined,
				}),
				ELECTRIC_PORT,
			)
		let response = await send()
		for (let attempt = 1; attempt <= UNAVAILABLE_RETRIES && response.status === 503; attempt++) {
			await response.body?.cancel()
			console.warn({ event: 'electric_unavailable_retry', attempt })
			await new Promise((resolve) => setTimeout(resolve, UNAVAILABLE_RETRY_DELAY_MS))
			response = await send()
		}
		return response
	}

	/** Starts the container if needed and waits until Electric's health reports `active`. */
	private waitUntilActive(): Promise<void> {
		if (this.ready && this.ctx.container?.running) return this.ready
		const pending = this.bootAndWaitForHealth().catch((error: unknown) => {
			if (this.ready === pending) this.ready = undefined
			throw error
		})
		this.ready = pending
		return pending
	}

	private async bootAndWaitForHealth(): Promise<void> {
		const startedAt = Date.now()
		const deadline = startedAt + READY_DEADLINE_MS
		await this.startAndWaitForPorts({
			ports: ELECTRIC_PORT,
			cancellationOptions: {
				instanceGetTimeoutMS: READY_DEADLINE_MS,
				portReadyTimeoutMS: READY_DEADLINE_MS,
				waitInterval: HEALTH_POLL_INTERVAL_MS,
			},
		})
		let lastStatus = 'unknown'
		while (Date.now() < deadline) {
			const response = await this.containerFetch('http://localhost/v1/health', ELECTRIC_PORT)
			const body = await response.text()
			lastStatus = `${response.status} ${body}`
			// 200 {"status":"active"}; 202 {"status":"starting"|"waiting"} while it connects or
			// waits for the advisory lock held by a previous instance.
			if (response.status === 200) {
				console.log({ event: 'electric_ready', waitedMs: Date.now() - startedAt })
				return
			}
			await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS))
		}
		// Let the request through anyway; Electric answers 503 itself while not ready and the
		// Electric client retries those with backoff.
		console.warn({ event: 'electric_ready_timeout', waitedMs: Date.now() - startedAt, lastStatus })
	}
}

function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder()
	const left = encoder.encode(a)
	const right = encoder.encode(b)
	if (left.byteLength !== right.byteLength) return false
	return crypto.subtle.timingSafeEqual(left, right)
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		let forwarded = request
		// Service-binding callers never use the workers.dev hostname. If the Worker is ever exposed
		// on workers.dev (debugging only), demand the internal secret and strip it before forwarding.
		if (url.hostname.endsWith('.workers.dev')) {
			const provided = request.headers.get(PUBLIC_ACCESS_HEADER)
			if (!env.INTERNAL_SERVICE_SECRET || !provided || !timingSafeEqual(provided, env.INTERNAL_SERVICE_SECRET)) {
				return new Response('Not found', { status: 404 })
			}
			const headers = new Headers(request.headers)
			headers.delete(PUBLIC_ACCESS_HEADER)
			forwarded = new Request(request, { headers })
		}
		const stub = env.ELECTRIC.get(env.ELECTRIC.idFromName(ELECTRIC_INSTANCE_NAME))
		return stub.fetch(forwarded)
	},
} satisfies ExportedHandler<Env>
