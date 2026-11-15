/**
 * One Durable Object (and one Cloudflare Container) per host id, built on the Sandbox SDK.
 *
 * Lifetime policy
 *  - keepAlive: the daemon only makes outbound connections, which do not count as activity, so the
 *    default `sleepAfter` would stop the container ~10 minutes after the last API call. With
 *    keepAlive the Sandbox's onActivityExpired never stops the container; the Container alarm
 *    loop keeps the DO resident while the container runs.
 *  - watchdog: a Container `schedule()` callback every WATCHDOG_SECONDS. Schedules survive container
 *    stops (the alarm keeps firing while schedules exist), so it (a) destroys the container once
 *    `expiresAt` passes and (b) restarts and re-bootstraps the container if the platform stopped it
 *    (host maintenance, crash). For (b) the DO keeps the rendered env file (it contains the daemon
 *    token and agent credentials) in its own storage, which is encrypted at rest and readable only
 *    by this object.
 *  - destroy: cancels the watchdog, SIGKILLs the container via Sandbox.destroy(), forgets the
 *    stored inputs and drops the host from the registry.
 */
import { Sandbox } from '@cloudflare/sandbox'

import {
	buildHostEnv,
	logsCommand,
	parseLogsOutput,
	parseStatusOutput,
	renderBootstrapScript,
	renderEnvFile,
	STATUS_COMMAND,
	STAGING_DIR_NAME,
	stateFromStatus,
} from '../bootstrap'
import type { Env } from '../env'
import type { CliArtifact } from '../providers/types'
import { redact } from '../redact'
import type { HostInfo, HostLogs } from '../schemas'

export const CF_STAGING = `/root/${STAGING_DIR_NAME}`
export const WATCHDOG_SECONDS = 300
const META_KEY = 'hlhost:meta'
const SECRET_KEY = 'hlhost:inputs'

export interface HostMeta {
	hostId: string
	createdAt: string
	expiresAt: string
	cliVersion: string | null
	labels: Record<string, string>
	instanceType: string
	restarts: number
	lastBootstrapAt: string | null
	lastWatchdogAt: string | null
	lastStopReason: string | null
}

interface StoredInputs {
	script: string
	envFile: string
}

export interface HostCreateParams {
	hostId: string
	daemonToken: string
	env: Record<string, string>
	ttlMinutes: number
	labels: Record<string, string>
	cli: CliArtifact
}

export interface HostCreateResult {
	created: boolean
	host: HostInfo
	timings?: Record<string, number>
}

export class HostSandbox extends Sandbox<Env> {
	private async meta(): Promise<HostMeta | undefined> {
		return this.ctx.storage.get<HostMeta>(META_KEY)
	}

	private registry() {
		return this.env.HOST_REGISTRY.get(this.env.HOST_REGISTRY.idFromName('global'))
	}

	private async applyConfig(hostId: string, labels: Record<string, string>) {
		await (this.configure as (c: unknown) => Promise<void>)({
			sandboxName: { name: hostId, normalizeId: false },
			keepAlive: true,
			sleepAfter: '10m',
			labels: { ...labels, app: 'humanlayer', hostId },
			// First start pulls the image from Docker Hub; give it room.
			containerTimeouts: { instanceGetTimeoutMS: 180_000, portReadyTimeoutMS: 180_000 },
		})
	}

	private async scheduleWatchdog() {
		this.deleteSchedules('hlWatchdog')
		await this.schedule(WATCHDOG_SECONDS, 'hlWatchdog')
	}

	/** Upload inputs and launch the bootstrap detached. Starts the container if needed. */
	private async runBootstrap(inputs: StoredInputs): Promise<{ containerReadyMs: number; totalMs: number }> {
		const t0 = Date.now()
		await this.exec(`umask 077; mkdir -p ${CF_STAGING}; chmod 700 ${CF_STAGING}`)
		const containerReadyMs = Date.now() - t0
		await this.writeFile(`${CF_STAGING}/host.env`, inputs.envFile)
		await this.writeFile(`${CF_STAGING}/bootstrap.sh`, inputs.script)
		await this.exec(`chmod 600 ${CF_STAGING}/host.env; chmod 700 ${CF_STAGING}/bootstrap.sh`)
		await this.startProcess(`bash ${CF_STAGING}/bootstrap.sh ${CF_STAGING}`)
		const meta = await this.meta()
		if (meta) await this.ctx.storage.put(META_KEY, { ...meta, lastBootstrapAt: new Date().toISOString() })
		return { containerReadyMs, totalMs: Date.now() - t0 }
	}

	private render(p: Omit<HostCreateParams, 'ttlMinutes' | 'labels'>): StoredInputs {
		return {
			script: renderBootstrapScript({
				hostId: p.hostId,
				provider: 'cloudflare',
				cliUrl: p.cli.url,
				cliSha256: p.cli.sha256,
				cliVersion: p.cli.version,
			}),
			envFile: renderEnvFile(
				buildHostEnv({ hostId: p.hostId, provider: 'cloudflare', daemonToken: p.daemonToken, env: p.env }),
			),
		}
	}

	async hlCreate(p: HostCreateParams): Promise<HostCreateResult> {
		const existing = await this.meta()
		if (existing) return { created: false, host: await this.hlStatus() }
		const now = Date.now()
		const meta: HostMeta = {
			hostId: p.hostId,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + p.ttlMinutes * 60_000).toISOString(),
			cliVersion: p.cli.version,
			labels: p.labels,
			instanceType: this.env.CLOUDFLARE_INSTANCE_TYPE ?? 'standard-2',
			restarts: 0,
			lastBootstrapAt: null,
			lastWatchdogAt: null,
			lastStopReason: null,
		}
		const inputs = this.render(p)
		await this.ctx.storage.put({ [META_KEY]: meta, [SECRET_KEY]: inputs })
		await this.registry().add(p.hostId, { createdAt: meta.createdAt, expiresAt: meta.expiresAt })
		await this.applyConfig(p.hostId, p.labels)
		await this.scheduleWatchdog()
		const timings = await this.runBootstrap(inputs)
		return { created: true, host: await this.hlStatus(), timings }
	}

	async hlRebootstrap(p: Omit<HostCreateParams, 'ttlMinutes' | 'labels'>): Promise<HostInfo | null> {
		const meta = await this.meta()
		if (!meta) return null
		const inputs = this.render(p)
		await this.ctx.storage.put({ [META_KEY]: { ...meta, cliVersion: p.cli.version }, [SECRET_KEY]: inputs })
		await this.applyConfig(meta.hostId, meta.labels)
		await this.runBootstrap(inputs)
		return this.hlStatus()
	}

	private async containerUp(): Promise<{ up: boolean; status: string }> {
		const st = await this.getState()
		return { up: st.status === 'running' || st.status === 'healthy', status: st.status }
	}

	async hlStatus(): Promise<HostInfo> {
		const meta = await this.meta()
		const base: HostInfo = {
			provider: 'cloudflare',
			hostId: meta?.hostId ?? '',
			sandboxId: meta?.hostId ?? null,
			state: 'not_found',
			providerState: null,
			bootstrapPhase: null,
			supervisorRunning: null,
			daemonRunning: null,
			error: null,
			createdAt: meta?.createdAt ?? null,
			expiresAt: meta?.expiresAt ?? null,
			size: null,
			cliVersion: meta?.cliVersion ?? null,
		}
		if (!meta) return base
		// Never call exec() on a stopped container: that would start it.
		const c = await this.containerUp()
		if (!c.up) return { ...base, state: 'stopped', providerState: c.status, error: meta.lastStopReason }
		const res = await this.exec(STATUS_COMMAND)
		const s = parseStatusOutput(res.stdout)
		return {
			...base,
			providerState: `${c.status}; instance=${meta.instanceType}; restarts=${meta.restarts}`,
			state: stateFromStatus(s),
			bootstrapPhase: s.phase,
			supervisorRunning: s.supervisorRunning,
			daemonRunning: s.daemonRunning,
			error: s.error ? redact(s.error) : null,
		}
	}

	async hlLogs(lines: number): Promise<HostLogs | null> {
		const meta = await this.meta()
		if (!meta) return null
		const c = await this.containerUp()
		if (!c.up) return { provider: 'cloudflare', hostId: meta.hostId, bootstrap: '', daemon: '' }
		const res = await this.exec(logsCommand(lines))
		return { provider: 'cloudflare', hostId: meta.hostId, ...parseLogsOutput(redact(res.stdout)) }
	}

	async hlDestroy(reason = 'destroyed'): Promise<{ destroyed: boolean }> {
		const meta = await this.meta()
		if (!meta) return { destroyed: false }
		this.deleteSchedules('hlWatchdog')
		await this.ctx.storage.delete([META_KEY, SECRET_KEY])
		try {
			await this.setKeepAlive(false)
			await this.destroy()
		} finally {
			await this.registry().remove(meta.hostId)
		}
		console.log(JSON.stringify({ event: 'hlhost.destroy', hostId: meta.hostId, reason }))
		return { destroyed: true }
	}

	/** Container schedule callback (see class comment). Must stay a public method. */
	async hlWatchdog(): Promise<void> {
		const meta = await this.meta()
		if (!meta) return
		if (Date.now() >= Date.parse(meta.expiresAt)) {
			await this.hlDestroy('expired')
			return
		}
		await this.scheduleWatchdog()
		const c = await this.containerUp()
		const now = new Date().toISOString()
		if (c.up) {
			await this.ctx.storage.put(META_KEY, { ...meta, lastWatchdogAt: now })
			return
		}
		const inputs = await this.ctx.storage.get<StoredInputs>(SECRET_KEY)
		if (!inputs) return
		console.log(JSON.stringify({ event: 'hlhost.restart', hostId: meta.hostId, containerStatus: c.status }))
		await this.ctx.storage.put(META_KEY, {
			...meta,
			restarts: meta.restarts + 1,
			lastWatchdogAt: now,
			lastStopReason: `container was ${c.status}; restarted by watchdog at ${now}`,
		})
		await this.applyConfig(meta.hostId, meta.labels)
		await this.runBootstrap(inputs)
	}

	/** Test/ops hook: read the non-secret metadata. */
	async hlMeta(): Promise<HostMeta | null> {
		return (await this.meta()) ?? null
	}
}
