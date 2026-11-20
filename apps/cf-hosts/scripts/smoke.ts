/**
 * End-to-end smoke test against a deployed human-flare-hosts Worker.
 *
 *   bun run scripts/smoke.ts --provider daytona [--keep] [--minutes 12] [--base <hosts origin>]
 *
 * Reads INTERNAL_SERVICE_SECRET, RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY and the human-flare-hosts origin from
 * the repo's .env.cloudflare (exported variables take precedence).
 *
 * Signs a throwaway daemon token (invented user/org/host UUIDs) with RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY,
 * exactly as apps/riptide-api/src/auth/daemon-tokens.ts does, creates a host, polls status, prints
 * the (server-redacted) logs, then destroys the host and confirms it is gone. Never prints secrets.
 */
import { parseArgs } from 'node:util'

import { importPKCS8, SignJWT } from 'jose'

import { readEnvFile, resolveOrigins } from '../../../scripts/cloudflare/config'

const deployment: NodeJS.ProcessEnv = { ...readEnvFile(), ...process.env }

const { values } = parseArgs({
	options: {
		provider: { type: 'string', default: 'cloudflare' },
		base: { type: 'string' },
		keep: { type: 'boolean', default: false },
		minutes: { type: 'string', default: '12' },
		lines: { type: 'string', default: '120' },
		'host-id': { type: 'string' },
		'destroy-only': { type: 'boolean', default: false },
	},
})

const secret = deployment.INTERNAL_SERVICE_SECRET
const keyB64 = deployment.RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY
if (!secret || !keyB64) throw new Error('INTERNAL_SERVICE_SECRET and RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY must be set')

const base = values.base ?? resolveOrigins(deployment).hosts
const provider = values.provider ?? 'cloudflare'
const hostId = values['host-id'] ?? crypto.randomUUID()
const auth = { authorization: `Bearer ${secret}` }
const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
let token = ''
const scrub = (s: string) => (token ? s.split(token).join('[TOKEN]') : s)
const log = (...a: unknown[]) =>
	console.log(`[${el()}]`, ...a.map((x) => scrub(typeof x === 'string' ? x : JSON.stringify(x))))

type HostView = {
	state?: string
	bootstrapPhase?: string
	supervisorRunning?: boolean
	daemonRunning?: boolean
	providerState?: string
	error?: string
}
type ApiBody = {
	host?: HostView
	hosts?: { hostId: string; providerState: string }[]
	bootstrap?: string
	daemon?: string
} | null

async function call(method: string, path: string, body?: unknown) {
	const headers = new Headers(auth)
	if (body) headers.set('content-type', 'application/json')
	const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
	const text = await res.text()
	let json: unknown = text
	try {
		json = JSON.parse(text)
	} catch {}
	return { status: res.status, json: json as ApiBody }
}

async function destroy() {
	const d = await call('DELETE', `/v1/hosts/${provider}/${hostId}`)
	log(`DELETE -> ${d.status}`, d.json)
	const s = await call('GET', `/v1/hosts/${provider}/${hostId}`)
	log(`GET after destroy -> ${s.status} state=${s.json?.host?.state}`)
	const l = await call('GET', `/v1/hosts?provider=${provider}`)
	log(
		`list ${provider}: ${l.json?.hosts?.length ?? '?'} host(s): ${JSON.stringify((l.json?.hosts ?? []).map((h) => `${h.hostId}:${h.providerState}`))}`,
	)
}

if (values['destroy-only']) {
	await destroy()
	process.exit(0)
}

const userId = crypto.randomUUID()
const organizationId = crypto.randomUUID()
const key = await importPKCS8(Buffer.from(keyB64, 'base64').toString('utf8'), 'RS256')
token = await new SignJWT({ userId, organizationId, hostId, createdAt: Date.now() })
	.setProtectedHeader({ alg: 'RS256' })
	.sign(key)
log(`provider=${provider} hostId=${hostId} userId=${userId} orgId=${organizationId} (token signed, not shown)`)

const created = await call('POST', '/v1/hosts', {
	provider,
	hostId,
	daemonToken: token,
	env: {},
	ttlMinutes: 60,
	size: 'medium',
	labels: { purpose: 'smoke-test' },
})
log(`POST /v1/hosts -> ${created.status}`, created.json)
if (created.status >= 300) process.exit(1)

let last = ''
const deadline = Date.now() + Number(values.minutes) * 60_000
let final: HostView | null | undefined = null
while (Date.now() < deadline) {
	const s = await call('GET', `/v1/hosts/${provider}/${hostId}`)
	const h = s.json?.host
	const line = `state=${h?.state} phase=${h?.bootstrapPhase} supervisor=${h?.supervisorRunning} daemon=${h?.daemonRunning} provider=${h?.providerState} error=${h?.error}`
	if (line !== last) {
		log(line)
		last = line
	}
	final = h
	if (h?.state === 'running' || h?.state === 'failed') break
	await new Promise((r) => setTimeout(r, 10_000))
}
// Give the daemon a moment to try the API after it starts.
if (final?.state === 'running') await new Promise((r) => setTimeout(r, 20_000))

const logs = await call('GET', `/v1/hosts/${provider}/${hostId}/logs?lines=${values.lines}`)
console.log(`\n===== bootstrap.log (tail) =====\n${scrub(logs.json?.bootstrap ?? JSON.stringify(logs.json))}`)
console.log(`===== daemon.log (tail) =====\n${scrub(logs.json?.daemon ?? '')}`)

if (!values.keep) await destroy()
else
	log(
		`kept host ${hostId}; destroy with: bun run scripts/smoke.ts --provider ${provider} --host-id ${hostId} --destroy-only`,
	)
