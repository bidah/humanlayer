/**
 * Cloudflare bindings for the Worker entry. Kept as structural types so this module (imported by
 * shared code paths) does not depend on `@cloudflare/workers-types` globals.
 */
export interface HyperdriveBinding {
	readonly connectionString: string
}

export interface KvNamespaceBinding {
	get(key: string): Promise<string | null>
	put(key: string, value: string): Promise<void>
	delete(key: string): Promise<void>
}

export interface R2ObjectBodyLike {
	readonly body: ReadableStream
	readonly size: number
	readonly httpEtag: string
	readonly httpMetadata?: { contentType?: string }
}

export interface R2BucketBinding {
	get(key: string): Promise<R2ObjectBodyLike | null>
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>
}

export interface FetcherBinding {
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface WorkerEnv {
	readonly HYPERDRIVE?: HyperdriveBinding
	readonly BILLING_KV?: KvNamespaceBinding
	readonly ARTIFACTS?: R2BucketBinding
	readonly STREAMS?: FetcherBinding
	/** The cloud host provisioner (`humanlayer-hosts`); see effects/services/cloud-hosts. */
	readonly HOSTS?: FetcherBinding
	/** Producer for the `humanlayer-background` queue (platform/background-jobs.ts). */
	readonly BACKGROUND_QUEUE?: {
		send(body: unknown, options?: { contentType?: 'json'; delaySeconds?: number }): Promise<unknown>
	}
	readonly [key: string]: unknown
}

let workerEnv: WorkerEnv | undefined

/** Set once per isolate by the Worker entry, before any request is handled. */
export function setWorkerEnv(env: WorkerEnv): void {
	workerEnv = env
}

export function getWorkerEnv(): WorkerEnv {
	if (!workerEnv) throw new Error('Worker env accessed before the Worker entry initialised it')
	return workerEnv
}

/** The env if running as a Worker that has been initialised, otherwise undefined (Node). */
export function getOptionalWorkerEnv(): WorkerEnv | undefined {
	return workerEnv
}
