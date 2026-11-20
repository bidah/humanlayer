/**
 * Smoke test for the human-flare-sync Worker (src/worker.ts), run against `wrangler dev` with the
 * stub upstreams in ./stubs, or against a deployment. Not part of `bun run test` (needs a live
 * Worker, a database and secrets).
 *
 *   SYNC_URL=http://localhost:8799 \
 *   RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY=<base64 PEM> ELECTRIC_SECRET=... \
 *   SMOKE_ORG_ID=<uuid> SMOKE_USER_ID=<id> SMOKE_SESSION_ID=<uuid> \
 *   bun test/worker/smoke.ts [--stubbed]
 *
 * SMOKE_SESSION_ID must name a session in SMOKE_ORG_ID created by SMOKE_USER_ID (owner access),
 * so the Postgres ACL check passes. `--stubbed` adds assertions that only hold for the stubs
 * (echoed shape params, SSE timing, long-poll hold).
 */
import { importPKCS8, SignJWT } from 'jose'

const baseUrl = (process.env.SYNC_URL ?? 'http://localhost:8799').replace(/\/+$/, '')
const stubbed = process.argv.includes('--stubbed')
const orgId = required('SMOKE_ORG_ID')
const userId = required('SMOKE_USER_ID')
const sessionId = required('SMOKE_SESSION_ID')
const hostId = process.env.SMOKE_HOST_ID ?? 'smoke-host'
const taskId = crypto.randomUUID()

function required(name: string) {
	const value = process.env[name]
	if (!value) throw new Error(`${name} is required`)
	return value
}

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
	if (!ok) failures++
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`)
}

async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function signDaemonToken() {
	const pem = Buffer.from(required('RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY'), 'base64').toString('utf-8')
	const key = await importPKCS8(pem, 'RS256')
	return new SignJWT({ userId, organizationId: orgId, hostId, createdAt: Date.now() })
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuedAt()
		.sign(key)
}

const token = await signDaemonToken()
const daemon = { 'x-daemon-authorization': token }

// 1. Health
{
	const response = await fetch(`${baseUrl}/`)
	check(
		'GET / -> online',
		response.status === 200 && ((await response.json()) as { status?: string }).status === 'online',
	)
}

// 2. Auth
{
	const response = await fetch(`${baseUrl}/v2/daemon/workspace-setup?offset=-1`)
	check('unauthenticated daemon shape -> 401', response.status === 401, response.status)
	const bad = await fetch(`${baseUrl}/v2/daemon/workspace-setup?offset=-1`, {
		headers: { 'x-daemon-authorization': `${token.slice(0, -4)}AAAA` },
	})
	check('tampered daemon token -> 401', bad.status === 401, bad.status)
	const user = await fetch(`${baseUrl}/v2/tasks?offset=-1`, { headers: { authorization: 'Bearer not.a.jwt' } })
	check('malformed user JWT -> 401', user.status === 401, user.status)
}

// 3. Daemon shape route reaches Electric with server-chosen table/where/params and the secret
{
	const response = await fetch(`${baseUrl}/v2/daemon/workspace-setup?offset=-1&table=users&where=true`, {
		headers: daemon,
	})
	const body = (await response.json()) as Record<string, unknown>
	check('daemon shape -> 200 from upstream', response.status === 200, response.status)
	check('electric-handle header passed through', response.headers.get('electric-handle') !== null)
	if (stubbed) {
		const params = body.params as Record<string, string>
		check('table is server-chosen', body.table === 'task_workspace_setup_for_host', body.table)
		check(
			'where is server-chosen',
			typeof body.where === 'string' && !String(body.where).includes('true'),
			body.where,
		)
		check(
			'params carry org + host from the token',
			Object.values(params).includes(orgId) && Object.values(params).includes(hostId),
			params,
		)
		const secret = process.env.ELECTRIC_SECRET
		check(
			'secret query param forwarded',
			secret ? body.secretSha256 === (await sha256Hex(secret)) : body.secretSha256 !== null,
		)
	}
}

// 4. Daemon PUT/POST/GET on a task diff-files stream
{
	const path = `${baseUrl}/v2/streams/organizations/${orgId}/tasks/${taskId}/diff-files`
	const put = await fetch(path, { method: 'PUT', headers: { ...daemon, 'content-type': 'application/json' } })
	check('PUT diff-files stream -> 201', put.status === 201, put.status)
	if (stubbed)
		check(
			'upstream path rewritten',
			put.headers.get('x-stub-path') === `/v1/stream/organizations/${orgId}/tasks/${taskId}/diff-files`,
			put.headers.get('x-stub-path'),
		)
	const post = await fetch(path, {
		method: 'POST',
		headers: { ...daemon, 'content-type': 'application/json' },
		body: JSON.stringify([{ file: 'a.ts', n: 1 }]),
	})
	check(
		'POST diff-files append -> upstream status (204 null body)',
		post.status === 204 || post.status === 200,
		post.status,
	)
	check('POST 204 has empty body', (await post.text()) === '')
	const get = await fetch(`${path}?offset=-1`, { headers: daemon })
	const text = await get.text()
	check('GET diff-files -> 200 with appended data', get.status === 200 && text.includes('a.ts'), {
		status: get.status,
		text,
	})
	check('stream responses are no-transform', (get.headers.get('cache-control') ?? '').includes('no-transform'))
	const wrongOrg = await fetch(
		`${baseUrl}/v2/streams/organizations/${crypto.randomUUID()}/tasks/${taskId}/diff-files`,
		{
			headers: daemon,
		},
	)
	check('other org diff-files -> 403', wrongOrg.status === 403, wrongOrg.status)
}

// 5. Postgres ACL check (canReadSession), single + 20 concurrent
{
	const url = `${baseUrl}/streams/sessions/${sessionId}?offset=-1`
	// Writes need a daemon (hostId) token and also pass through canReadSession.
	const created = await fetch(`${baseUrl}/streams/sessions/${sessionId}`, {
		method: 'PUT',
		headers: { ...daemon, 'content-type': 'application/json' },
	})
	await created.arrayBuffer()
	check(
		'session stream PUT (ACL passed) -> 200/201',
		created.status === 200 || created.status === 201,
		created.status,
	)
	const response = await fetch(url, { headers: daemon })
	await response.arrayBuffer()
	// 403 = ACL denied or the query failed (queries.ts maps errors to no_access).
	check('session stream GET (ACL passed) -> 200', response.status === 200, response.status)
	const denied = await fetch(`${baseUrl}/streams/sessions/${crypto.randomUUID()}?offset=-1`, { headers: daemon })
	check('unknown session -> 403', denied.status === 403, denied.status)

	const started = Date.now()
	const statuses = await Promise.all(
		Array.from({ length: 20 }, async (_, index) => {
			const target = index % 4 === 3 ? `${baseUrl}/streams/sessions/${crypto.randomUUID()}?offset=-1` : url
			const r = await fetch(target, { headers: daemon })
			await r.arrayBuffer()
			return { expectDenied: index % 4 === 3, status: r.status }
		}),
	)
	const ok = statuses.every((s) => (s.expectDenied ? s.status === 403 : s.status === 200))
	check(
		`20 concurrent ACL requests (${Date.now() - started} ms)`,
		ok,
		statuses.map((s) => s.status),
	)
}

// 6. SSE passes through incrementally
if (stubbed) {
	const path = `${baseUrl}/v2/streams/organizations/${orgId}/tasks/${taskId}/diff-files?offset=-1&live=sse`
	const started = Date.now()
	const response = await fetch(path, { headers: daemon })
	check('SSE content-type', (response.headers.get('content-type') ?? '').startsWith('text/event-stream'))
	const reader = response.body!.getReader()
	const decoder = new TextDecoder()
	const arrivals: number[] = []
	let buffer = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const events = buffer.split('\n\n')
		buffer = events.pop() ?? ''
		for (const event of events) if (event.includes('data:')) arrivals.push(Date.now() - started)
	}
	const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!)
	check('SSE events arrive ~1 s apart (not buffered)', arrivals.length === 5 && gaps.every((gap) => gap > 500), {
		arrivalsMs: arrivals,
	})
}

// 7. Electric long-poll held by upstream passes through
if (stubbed && !process.argv.includes('--skip-long-poll')) {
	const started = Date.now()
	const response = await fetch(`${baseUrl}/v2/daemon/workspace-setup?offset=0_0&handle=stub-handle&live=true`, {
		headers: daemon,
	})
	const body = (await response.json()) as { heldMs: number }
	const elapsed = Date.now() - started
	check('long-poll held ~20 s and returned 200', response.status === 200 && elapsed >= 19_000, {
		status: response.status,
		elapsedMs: elapsed,
		upstreamHeldMs: body.heldMs,
	})
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
