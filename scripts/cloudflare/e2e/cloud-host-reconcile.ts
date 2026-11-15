// End-to-end check of the cloud host reconcile pass (humanlayer-jobs, every minute).
//
//   bun scripts/cloudflare/e2e/cloud-host-reconcile.ts --provider cloudflare
//
// Reads .env.cloudflare (exported variables take precedence; see ./env.ts).
//
// Creates a cloud host through the API, waits until it is ready, then deletes its sandbox directly
// on the provisioner behind the API's back (what the provisioner's TTL does). The reconcile pass
// must notice within a couple of minutes: row destroyed and revoked, online_hosts row removed.
import { parseArgs } from 'node:util'

import { bootstrapCredentials, refresh, signIn } from './auth-client'
import { API, HOSTS, deploymentEnv } from './env'

const { values } = parseArgs({ options: { provider: { type: 'string', default: 'cloudflare' } } })
const provider = values.provider!
const { DATABASE_URL, INTERNAL_SERVICE_SECRET } = deploymentEnv
if (!DATABASE_URL || !INTERNAL_SERVICE_SECRET) {
	throw new Error('.env.cloudflare must set DATABASE_URL and INTERNAL_SERVICE_SECRET')
}

const t0 = Date.now()
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`
let fails = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
	if (!ok) fails++
	console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function rpc(token: string, path: string, input: unknown = {}) {
	const response = await fetch(`${API}/rpc/api/v1/${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	return { status: response.status, body: (await response.json().catch(() => null)) as any }
}
const sql = new Bun.SQL(DATABASE_URL)

const { email, password } = await bootstrapCredentials()
let tokens = await signIn(email, password)
const org = (await rpc(tokens.access_token, 'auth/user/organizations/list')).body?.organizations?.[0]
tokens = await refresh(tokens.refresh_token, new URL(org.signInUrl).searchParams.get('organization_id') ?? undefined)
const token = tokens.access_token

const created = await rpc(token, 'hosts/cloud/create', { provider, ttlMinutes: 30 })
check(`create (${provider})`, created.status === 200, created.body?.host?.status)
const hostId: string = created.body.host.hostId
try {
	let status = ''
	for (let i = 0; i < 120 && status !== 'ready' && status !== 'failed'; i++) {
		await sleep(5_000)
		status = (await rpc(token, 'hosts/cloud/get', { hostId })).body?.host?.status
	}
	check('host ready', status === 'ready', status)
	const [online] = await sql`select status from online_hosts where host_id = ${hostId}`
	check('online_hosts row online', online?.status === 'online', online)

	const deleted = await fetch(`${HOSTS}/v1/hosts/${provider}/${hostId}`, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${INTERNAL_SERVICE_SECRET}` },
	})
	check('sandbox deleted on the provisioner, bypassing the API', deleted.status === 200, deleted.status)

	let row: any
	for (let i = 0; i < 40; i++) {
		;[row] = await sql`select status, error, revoked_at, destroyed_at from cloud_hosts where host_id = ${hostId}`
		if (row?.status === 'destroyed') break
		await sleep(5_000)
	}
	check(
		'reconcile pass marked the row destroyed and revoked',
		row?.status === 'destroyed' && row?.revoked_at !== null,
		row,
	)
	const onlineAfter = await sql`select status from online_hosts where host_id = ${hostId}`
	check('reconcile pass removed the online_hosts row', onlineAfter.length === 0, onlineAfter)
} finally {
	const [row] = await sql`select status from cloud_hosts where host_id = ${hostId}`
	if (row?.status !== 'destroyed')
		console.log(stamp(), 'cleanup destroy', (await rpc(token, 'hosts/cloud/destroy', { hostId })).status)
	const live = await sql`select host_id from cloud_hosts where status <> 'destroyed'`
	check('no live cloud_hosts rows', live.length === 0, live)
	await sql.close()
}
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED')
process.exit(fails ? 1 : 0)
