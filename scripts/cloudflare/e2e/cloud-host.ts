// End-to-end check of cloud hosts on the Cloudflare deployment.
//
//   bun scripts/cloudflare/e2e/cloud-host.ts --provider daytona      # or cloudflare
//
// Reads .env.cloudflare (exported variables take precedence; see ./env.ts).
//
// Signs in as the bootstrap user, scopes to the existing organization, creates a cloud host through
// the API, waits until the daemon's heartbeat makes it ready, checks online_hosts and the /v3/hosts
// shape, reads the logs, destroys it, and checks that its daemon token is rejected by the API and
// the sync proxy afterwards. The token check uses a token minted here from the private key with the
// same claims the API mints (the product never returns the token). No secret is printed.
// The host is always destroyed, also when a check fails.
import { parseArgs } from 'node:util'

import { bootstrapCredentials, claims, refresh, signIn } from './auth-client'
import { API, HOSTS, SYNC, deploymentEnv } from './env'

const { values } = parseArgs({
	options: {
		provider: { type: 'string', default: 'cloudflare' },
		'timeout-minutes': { type: 'string', default: '12' },
	},
})
const provider = values.provider!
const { DATABASE_URL, INTERNAL_SERVICE_SECRET, RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY } = deploymentEnv
if (!DATABASE_URL || !INTERNAL_SERVICE_SECRET || !RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY) {
	throw new Error(
		'.env.cloudflare must set DATABASE_URL, INTERNAL_SERVICE_SECRET and RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY',
	)
}

const t0 = Date.now()
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`
let fails = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
	if (!ok) fails++
	console.log(
		`[${elapsed()}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 600)}`,
	)
}
const info = (message: string, detail?: unknown) =>
	console.log(
		`[${elapsed()}]      ${message}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 600)}`,
	)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Reads an Electric shape through the sync proxy up to `up-to-date` (non-live requests). */
async function readShape(path: string, token: string) {
	let url = `${SYNC}${path}?offset=-1`
	let body = ''
	let status = 0
	let requests = 0
	while (requests < 20) {
		requests++
		const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
		status = response.status
		const text = await response.text()
		body += text
		if (status !== 200 || response.headers.has('electric-up-to-date') || text.includes('"up-to-date"')) break
		const offset = response.headers.get('electric-offset')
		const handle = response.headers.get('electric-handle')
		if (!offset || !handle) break
		url = `${SYNC}${path}?offset=${encodeURIComponent(offset)}&handle=${encodeURIComponent(handle)}`
	}
	return { status, body, requests }
}

async function rpc(token: string, path: string, input: unknown = {}) {
	const response = await fetch(`${API}/rpc/api/v1/${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	const text = await response.text()
	let body: any = text
	try {
		body = JSON.parse(text)
	} catch {}
	return { status: response.status, body }
}

/** RS256 compact JWT via WebCrypto (the scripts directory has no jose dependency). */
async function signRs256(payload: Record<string, unknown>, base64Pkcs8Pem: string): Promise<string> {
	const pem = Buffer.from(base64Pkcs8Pem, 'base64').toString('utf8')
	const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
	const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
		'sign',
	])
	const b64u = (value: string | ArrayBuffer) => Buffer.from(value as never).toString('base64url')
	const input = `${b64u(JSON.stringify({ alg: 'RS256' }))}.${b64u(JSON.stringify(payload))}`
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
	return `${input}.${b64u(signature)}`
}

const sql = new Bun.SQL(DATABASE_URL)
const provisionerStatus = async (hostId: string) => {
	const response = await fetch(`${HOSTS}/v1/hosts/${provider}/${hostId}`, {
		headers: { authorization: `Bearer ${INTERNAL_SERVICE_SECRET}` },
	})
	const body: any = await response.json().catch(() => null)
	return { status: response.status, state: body?.host?.state as string | undefined }
}
const provisionerList = async () => {
	const response = await fetch(`${HOSTS}/v1/hosts?provider=${provider}`, {
		headers: { authorization: `Bearer ${INTERNAL_SERVICE_SECRET}` },
	})
	const body: any = await response.json().catch(() => null)
	return (body?.hosts ?? []) as Array<{ hostId: string; providerState: string | null }>
}

// a. sign in, scope to the organization
const { email, password } = await bootstrapCredentials()
let tokens = await signIn(email, password)
const orgs = await rpc(tokens.access_token, 'auth/user/organizations/list')
const org = orgs.body?.organizations?.[0]
if (!org) throw new Error(`no organization (${orgs.status})`)
const workosOrgId = new URL(org.signInUrl).searchParams.get('organization_id') ?? org.organizationId
tokens = await refresh(tokens.refresh_token, workosOrgId)
const userToken = tokens.access_token
check('signed in and scoped to the organization', !!claims(userToken).internal_org_id, { org: org.name })

const providers = await rpc(userToken, 'hosts/cloud/providers')
check('hosts.cloud.providers', providers.status === 200, providers.body)

let hostId: string | undefined
let destroyed = false
try {
	// a. create
	const created = await rpc(userToken, 'hosts/cloud/create', { provider, ttlMinutes: 60 })
	check(`hosts.cloud.create (${provider})`, created.status === 200, created.body?.host ?? created.body)
	if (created.status !== 200) throw new Error('create failed')
	hostId = created.body.host.hostId as string

	// b. poll until ready
	const deadline = Date.now() + Number(values['timeout-minutes']) * 60_000
	let last = ''
	let host: any
	while (Date.now() < deadline) {
		const got = await rpc(userToken, 'hosts/cloud/get', { hostId })
		host = got.body?.host
		const now = `${host?.status}/${host?.bootstrapPhase ?? '-'}`
		if (now !== last) info(`status ${now}`)
		last = now
		if (host?.status === 'ready' || host?.status === 'failed') break
		await sleep(5_000)
	}
	check('cloud host became ready (first daemon heartbeat accepted)', host?.status === 'ready', {
		status: host?.status,
		error: host?.error,
		readyAt: host?.readyAt,
	})

	const [row] =
		await sql`select organization_id, user_id, status, sandbox_id, revoked_at from cloud_hosts where host_id = ${hostId}`
	const [online] =
		await sql`select status, host_name, daemon_version, ephemeral from online_hosts where host_id = ${hostId}`
	check('online_hosts row exists with status online', online?.status === 'online', online)
	info('cloud_hosts row', { status: row?.status, sandbox: row?.sandbox_id, revoked: row?.revoked_at })

	// Read the shape the way a client does: from offset -1, following electric-offset until the
	// server says up-to-date. On an existing (cached) shape the first response holds only the
	// snapshot; rows written since are in the following log responses.
	const shapeRead = await readShape('/v3/hosts', userToken)
	check(
		'host visible in the /v3/hosts shape (user token, sync proxy)',
		shapeRead.status === 200 && shapeRead.body.includes(hostId),
		{ status: shapeRead.status, requests: shapeRead.requests },
	)

	// c. logs
	const logs = await rpc(userToken, 'hosts/cloud/logs', { hostId, lines: 40 })
	const bootstrapLog: string = logs.body?.bootstrap ?? ''
	check('hosts.cloud.logs returns the bootstrap log', logs.status === 200 && bootstrapLog.length > 0, {
		bootstrapLines: bootstrapLog.split('\n').length,
		daemonLines: (logs.body?.daemon ?? '').split('\n').length,
	})
	console.log(
		bootstrapLog
			.split('\n')
			.slice(-8)
			.map((line) => `           | ${line}`)
			.join('\n'),
	)

	// An equivalent daemon token (same claims the API mints for this host).
	const daemonToken = await signRs256(
		{ userId: row.user_id, organizationId: row.organization_id, hostId, createdAt: Date.now(), cloudHost: true },
		RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY,
	)
	const apiHeartbeat = () =>
		fetch(`${API}/rpc/daemon/v1/hosts/heartbeat`, {
			method: 'POST',
			headers: { 'x-daemon-authorization': daemonToken, 'content-type': 'application/json' },
			body: JSON.stringify({
				hostId,
				hostName: online?.host_name ?? 'cloud-host',
				daemonVersion: online?.daemon_version ?? undefined,
			}),
		})
	const proxyRequest = () =>
		fetch(`${SYNC}/v3/hosts?offset=-1`, { headers: { 'x-daemon-authorization': daemonToken } })
	const apiBefore = await apiHeartbeat()
	const proxyBefore = await proxyRequest()
	check(
		'control: the token is accepted before destroy (API heartbeat, proxy shape)',
		apiBefore.status === 200 && proxyBefore.status === 200,
		{
			api: apiBefore.status,
			proxy: proxyBefore.status,
		},
	)

	// d. destroy
	const destroyedResult = await rpc(userToken, 'hosts/cloud/destroy', { hostId })
	destroyed =
		destroyedResult.body?.host?.status === 'destroyed' || destroyedResult.body?.host?.status === 'destroying'
	check(
		'hosts.cloud.destroy',
		destroyedResult.status === 200 && destroyedResult.body?.host?.status === 'destroyed',
		destroyedResult.body?.host,
	)

	const after = await provisionerStatus(hostId)
	// Daytona keeps listing a deleted sandbox (as `started`) for a few seconds after the DELETE.
	let listed = (await provisionerList()).filter((h) => h.hostId === hostId)
	for (let attempt = 0; attempt < 10 && listed.some((h) => h.providerState !== 'destroying'); attempt++) {
		await sleep(3000)
		listed = (await provisionerList()).filter((h) => h.hostId === hostId)
	}
	check(
		'provisioner no longer has the host',
		after.status === 404 && (listed.length === 0 || listed.every((h) => h.providerState === 'destroying')),
		{
			statusCall: after,
			listed,
		},
	)
	const [rowAfter] = await sql`select status, revoked_at, destroyed_at from cloud_hosts where host_id = ${hostId}`
	check(
		'cloud_hosts row destroyed and revoked',
		rowAfter?.status === 'destroyed' && rowAfter?.revoked_at !== null,
		rowAfter,
	)
	const onlineAfter = await sql`select status from online_hosts where host_id = ${hostId}`
	check('online_hosts row removed', onlineAfter.length === 0, onlineAfter)

	const apiAfter = await apiHeartbeat()
	const proxyAfterNow = await proxyRequest()
	check('API rejects the destroyed host token (heartbeat)', apiAfter.status === 401, { status: apiAfter.status })
	info(`proxy right after destroy -> ${proxyAfterNow.status} (an isolate may cache "active" for up to 10 s)`)
	await sleep(11_000)
	const proxyAfter = await proxyRequest()
	check('sync proxy rejects the destroyed host token', proxyAfter.status === 401, { status: proxyAfter.status })
	const onlineFinal = await sql`select status from online_hosts where host_id = ${hostId}`
	check('the rejected heartbeat did not re-register the host', onlineFinal.length === 0)
} finally {
	if (hostId && !destroyed) {
		const cleanup = await rpc(userToken, 'hosts/cloud/destroy', { hostId })
		info('cleanup destroy', { status: cleanup.status, host: cleanup.body?.host?.status })
	}
	// e. nothing left running
	const live = await sql`select host_id, provider, status from cloud_hosts where status <> 'destroyed'`
	check('no live cloud_hosts rows', live.length === 0, live)
	const remaining = await provisionerList()
	info(`provisioner ${provider} hosts now: ${remaining.length}`, remaining)
	await sql.close()
}

console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED')
process.exit(fails ? 1 : 0)
