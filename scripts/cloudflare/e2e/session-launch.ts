// End-to-end check that a session launched in the product reaches a cloud host's daemon.
//
//   bun scripts/cloudflare/e2e/session-launch.ts                       # provider cloudflare
//   bun scripts/cloudflare/e2e/session-launch.ts --provider daytona
//   bun scripts/cloudflare/e2e/session-launch.ts --no-tail             # skip `wrangler tail`
//   bun scripts/cloudflare/e2e/session-launch.ts --no-provider-login   # skip the agent sign-in probe
//
// Reads .env.cloudflare (exported variables take precedence; see ./env.ts).
//
// Signs in as the bootstrap user, scoped to the existing organization, then:
//   1. creates a cloud host through the API and waits until its daemon heartbeat makes it ready;
//   2. launches a task with a first session on that host the way the web app's launcher does for a
//      directory-backed task (`tasks.launchDraft`, working directory = the host user's home, which
//      the bootstrap creates; no repository, no worktree);
//   3. watches the session row in Postgres and reports every status transition, the conversation
//      events, the session's durable stream (read through the sync proxy as the user), the host's
//      daemon log, and the daemon's requests to `humanlayer-api` and `humanlayer-sync` as seen by
//      `wrangler tail`;
//   4. asks the host's daemon for a Claude sign-in (`providerLogin.create`, what the app's "Sign in"
//      button does) and waits for the sign-in URL, then cancels the request without completing it;
//   5. destroys the host and deletes the task, session, task.md artifact and sign-in rows it created,
//      and restores the user's onboarding milestone (the first finished session stamps it).
//
// No model credential is passed to the host, so the agent is expected to fail to authenticate. The
// check PASSES when the daemon demonstrably took the session (ready_for_launch -> launching, which
// only the daemon writes) and attempted to start the agent (the session left `launching` with an
// agent-side outcome, or the daemon log shows the run). It prints where the pipeline stopped.
// No secret or token is printed; URLs are printed without their origin.
import { parseArgs } from 'node:util'

import { bootstrapCredentials, claims, refresh, signIn } from './auth-client'
import { API, HOSTS, SYNC, deploymentEnv } from './env'

const { values } = parseArgs({
	options: {
		provider: { type: 'string', default: 'cloudflare' },
		'timeout-minutes': { type: 'string', default: '12' },
		'session-timeout-seconds': { type: 'string', default: '240' },
		'no-tail': { type: 'boolean', default: false },
		'no-provider-login': { type: 'boolean', default: false },
		'keep-data': { type: 'boolean', default: false },
	},
})
const provider = values.provider!
const { DATABASE_URL, INTERNAL_SERVICE_SECRET } = deploymentEnv
if (!DATABASE_URL || !INTERNAL_SERVICE_SECRET) {
	throw new Error('.env.cloudflare must set DATABASE_URL and INTERNAL_SERVICE_SECRET')
}

const t0 = Date.now()
const elapsed = (at = Date.now()) => `${((at - t0) / 1000).toFixed(0).padStart(4)}s`
const iso = (at = Date.now()) => new Date(at).toISOString()
let fails = 0
const redact = (text: string) =>
	text
		.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>')
		.replace(/sk-ant-[\w-]+/g, '<anthropic-key>')
		.replace(/(bearer\s+)\S+/gi, '$1<redacted>')
const show = (detail: unknown) => (detail === undefined ? '' : ' ' + redact(JSON.stringify(detail)).slice(0, 700))
const check = (name: string, ok: boolean, detail?: unknown) => {
	if (!ok) fails++
	console.log(`[${elapsed()}] ${ok ? 'PASS' : 'FAIL'} ${name}${show(detail)}`)
}
const info = (message: string, detail?: unknown) => console.log(`[${elapsed()}]      ${message}${show(detail)}`)
const block = (lines: string[]) => {
	for (const line of lines) console.log(`           | ${redact(line).slice(0, 300)}`)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pathOf = (url: string) => {
	try {
		const parsed = new URL(url)
		return parsed.pathname + parsed.search
	} catch {
		return url
	}
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

// ---------------------------------------------------------------------------------------------
// wrangler tail: the request log of humanlayer-api and humanlayer-sync while the check runs.
// Only method, path, status, outcome and log/exception messages are kept; headers are dropped.
interface TailEvent {
	worker: string
	at: number
	method: string
	path: string
	status: number | null
	outcome: string
	logs: string[]
}
const tailEvents: TailEvent[] = []
const tails: Array<{ worker: string; proc: ReturnType<typeof Bun.spawn> }> = []

/** Splits a stream of concatenated pretty-printed JSON objects. */
function jsonObjects(onObject: (value: any) => void) {
	let buffer = ''
	return (chunk: string) => {
		buffer += chunk
		let depth = 0
		let inString = false
		let escaped = false
		let start = -1
		let consumed = 0
		for (let i = 0; i < buffer.length; i++) {
			const c = buffer[i]
			if (inString) {
				if (escaped) escaped = false
				else if (c === '\\') escaped = true
				else if (c === '"') inString = false
				continue
			}
			if (c === '"') inString = true
			else if (c === '{') {
				if (depth === 0) start = i
				depth++
			} else if (c === '}') {
				depth--
				if (depth === 0 && start >= 0) {
					try {
						onObject(JSON.parse(buffer.slice(start, i + 1)))
					} catch {}
					consumed = i + 1
					start = -1
				}
			}
		}
		buffer = buffer.slice(consumed)
	}
}

async function startTail(worker: string, packageDir: string) {
	const proc = Bun.spawn(['bun', '../../scripts/cloudflare/wrangler.ts', 'tail', '--format', 'json'], {
		cwd: `${import.meta.dir}/../../../${packageDir}`,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	tails.push({ worker, proc })
	const feed = jsonObjects((event) => {
		const request = event?.event?.request
		if (!request?.url) return
		tailEvents.push({
			worker,
			at: event.eventTimestamp ?? Date.now(),
			method: request.method,
			path: pathOf(request.url),
			status: event?.event?.response?.status ?? null,
			outcome: event.outcome,
			logs: [
				...(event.logs ?? []).map((log: any) => `${log.level}: ${[].concat(log.message).join(' ')}`),
				...(event.exceptions ?? []).map((ex: any) => `exception: ${ex.name}: ${ex.message}`),
			],
		})
	})
	void (async () => {
		const decoder = new TextDecoder()
		for await (const chunk of proc.stdout as ReadableStream<Uint8Array>)
			feed(decoder.decode(chunk, { stream: true }))
	})()
}

function stopTails() {
	for (const { proc } of tails) proc.kill()
}

/**
 * A daemon request: `/rpc/daemon/...` on the API; on the proxy, the shapes the daemon subscribes to
 * (`/v1/sessions/<hostId>`, `/v1/tasks`, `/v1/daemon/*`, `/v2/daemon/*`). The user-token reads this
 * script makes (`/v3/hosts`, `/streams/...`) do not match. `wrangler tail` prints ids in paths as
 * `REDACTED`, so routes are matched by prefix, not by host id.
 */
const isDaemonRequest = (event: TailEvent) =>
	event.worker === 'api'
		? event.path.startsWith('/rpc/daemon/')
		: /^\/(v1\/sessions\/|v1\/tasks|v1\/daemon\/|v2\/daemon\/)/.test(event.path)

/** Long-poll (`live=true`) shape requests end as `canceled` when the client re-polls; that is normal. */
const isFailure = (event: TailEvent) =>
	(event.status ?? 0) >= 400 || (event.outcome !== 'ok' && event.outcome !== 'canceled')

function summarizeDaemonTraffic(from: number, to: number) {
	const events = tailEvents.filter((event) => event.at >= from && event.at <= to && isDaemonRequest(event))
	const groups = new Map<string, { count: number; statuses: Set<string>; first: number }>()
	for (const event of events) {
		const route = event.path.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'REDACTED')
		const key = `${event.worker} ${event.method} ${route}`
		const group = groups.get(key) ?? { count: 0, statuses: new Set(), first: event.at }
		group.count++
		group.statuses.add(String(event.status ?? event.outcome))
		groups.set(key, group)
	}
	return [...groups.entries()]
		.sort((a, b) => a[1].first - b[1].first)
		.map(([key, g]) => `${elapsed(g.first)} ${key} x${g.count} -> ${[...g.statuses].join(',')}`)
}

// ---------------------------------------------------------------------------------------------
const sql = new Bun.SQL(DATABASE_URL)
const provisionerList = async () => {
	const response = await fetch(`${HOSTS}/v1/hosts?provider=${provider}`, {
		headers: { authorization: `Bearer ${INTERNAL_SERVICE_SECRET}` },
	})
	const body: any = await response.json().catch(() => null)
	return (body?.hosts ?? []) as Array<{ hostId: string; providerState: string | null }>
}

const { email, password } = await bootstrapCredentials()
let tokens = await signIn(email, password)
const orgs = await rpc(tokens.access_token, 'auth/user/organizations/list')
const org = orgs.body?.organizations?.[0]
if (!org) throw new Error(`no organization (${orgs.status})`)
const workosOrgId = new URL(org.signInUrl).searchParams.get('organization_id') ?? org.organizationId
tokens = await refresh(tokens.refresh_token, workosOrgId)
const userToken = tokens.access_token
check('signed in and scoped to the organization', !!claims(userToken).internal_org_id, { org: org.name })
const userId = claims(userToken).sub as string
const organizationId = claims(userToken).internal_org_id as string
const [settingsBefore] =
	await sql`select first_task_completed_at from user_settings where user_id = ${userId} and organization_id = ${organizationId}`

if (!values['no-tail']) {
	await startTail('api', 'apps/riptide-api')
	await startTail('sync', 'apps/riptide-electric-proxy')
	await sleep(6_000) // tail sessions take a few seconds to attach
	info('wrangler tail attached to humanlayer-api and humanlayer-sync')
}

let hostId: string | undefined
let destroyed = false
const taskId = Bun.randomUUIDv7()
const sessionId = Bun.randomUUIDv7()
const eventId = Bun.randomUUIDv7()
let launched = false
let hostCreatedAt = Date.now()
let loginRequestId: string | undefined
const stages: Array<[string, string]> = []
const stage = (name: string, result: string) => stages.push([name, result])

try {
	// 1. Cloud host
	hostCreatedAt = Date.now()
	const created = await rpc(userToken, 'hosts/cloud/create', { provider, ttlMinutes: 60 })
	check(`hosts.cloud.create (${provider})`, created.status === 200, created.body?.host ?? created.body)
	if (created.status !== 200) throw new Error('create failed')
	hostId = created.body.host.hostId as string
	const deadline = Date.now() + Number(values['timeout-minutes']) * 60_000
	let last = ''
	let host: any
	while (Date.now() < deadline) {
		const got = await rpc(userToken, 'hosts/cloud/get', { hostId })
		host = got.body?.host
		const now = `${host?.status}/${host?.bootstrapPhase ?? '-'}`
		if (now !== last) info(`host status ${now}`)
		last = now
		if (host?.status === 'ready' || host?.status === 'failed') break
		await sleep(5_000)
	}
	check('cloud host ready (daemon heartbeat accepted)', host?.status === 'ready', {
		status: host?.status,
		error: host?.error,
	})
	stage('host ready', host?.status === 'ready' ? `yes (${elapsed()})` : `no: ${host?.status} ${host?.error ?? ''}`)
	if (host?.status !== 'ready') throw new Error('host not ready')
	const [online] = await sql`select status, host_name, daemon_version from online_hosts where host_id = ${hostId}`
	info('online_hosts', online)
	// Let the daemon finish attaching its shapes before the launch, so the run shows the live path.
	await sleep(10_000)

	// 2. Launch (directory-backed task, as LauncherV3 sends it without a project)
	const launchAt = Date.now()
	const workingDirectory = '/home/humanlayer'
	const launch = await rpc(userToken, 'tasks/launchDraft', {
		draftId: taskId,
		name: 'E2E session launch',
		slug: `e2e-session-${taskId.slice(-8)}`,
		defaultWorkingDirectory: workingDirectory,
		taskContent: 'Reply with the single word: pong',
		workflowType: 'freeform',
		worktreeTiming: 'never',
		autoAdvanceQuestionsToResearch: false,
		autoAdvanceResearchToDesign: false,
		autoAdvancePlanToWorktree: false,
		autoAdvanceWorktreeToImplementation: false,
		autoAdvanceImplementationToPr: false,
		firstSession: {
			id: sessionId,
			eventId,
			title: 'E2E session launch',
			text: 'Reply with the single word: pong',
			workingDirectory,
			hostId,
			codingAgent: 'claude',
			provider: 'anthropic',
			model: 'sonnet',
			permissionsMode: 'default',
		},
	})
	launched = launch.status === 200
	check('tasks.launchDraft accepted', launched, {
		status: launch.status,
		outcome: launch.body?.outcome,
		firstSessionId: launch.body?.firstSessionId,
		error: launched ? undefined : launch.body,
	})
	stage('launch accepted by the API', launched ? `yes (${iso(launchAt)})` : `no: ${launch.status}`)
	if (!launched) throw new Error('launch failed')

	// 3. Watch the session row
	const transitions: Array<{ at: string; t: string; status: string; error?: string | null }> = []
	let row: any
	const sessionDeadline = Date.now() + Number(values['session-timeout-seconds']) * 1000
	const settled = new Set(['failed', 'ready_for_input', 'interrupted', 'lost', 'needs_approval'])
	while (Date.now() < sessionDeadline) {
		;[row] =
			await sql`select status, error_message, error_reason, coding_agent_session_id, num_events, resolved_model, updated_at from sessions where id = ${sessionId}`
		const lastStatus = transitions.at(-1)?.status
		if (row && row.status !== lastStatus) {
			transitions.push({ at: iso(), t: elapsed(), status: row.status, error: row.error_message })
			info(`session status -> ${row.status}`, row.error_message ? { error: row.error_message } : undefined)
		}
		if (row && settled.has(row.status)) break
		await sleep(1_000)
	}
	// Stay a little longer: a run can write events or a second status after its first terminal one.
	await sleep(8_000)
	;[row] =
		await sql`select status, error_message, error_reason, coding_agent_session_id, num_events, resolved_model from sessions where id = ${sessionId}`
	if (row && row.status !== transitions.at(-1)?.status) {
		transitions.push({ at: iso(), t: elapsed(), status: row.status, error: row.error_message })
	}
	info('session status transitions', transitions)
	info('final session row', row)

	const statuses = transitions.map((transition) => transition.status)
	const daemonTook = statuses.some((status) => status !== 'ready_for_launch' && status !== 'waiting_for_workspace')
	check('daemon received the session (status left ready_for_launch; only the daemon writes launching)', daemonTook, {
		statuses,
	})
	stage(
		'daemon received the session',
		daemonTook ? `yes (${transitions.find((t) => t.status !== 'ready_for_launch')?.at})` : 'no',
	)

	const [taskRow] =
		await sql`select setup_status, workspace_state, worktree_timing, default_working_directory from tasks where id = ${taskId}`
	info('task row', taskRow)

	const events =
		await sql`select event_type, role, created_at, left(coalesce(content::text, tool_result_content::text, ''), 400) as content from conversation_events where session_id = ${sessionId} order by created_at`
	info(`conversation_events rows: ${events.length}`)
	block(events.slice(0, 12).map((event: any) => JSON.stringify(event)))

	const stream = await fetch(`${SYNC}/streams/sessions/${sessionId}?offset=-1`, {
		headers: { authorization: `Bearer ${userToken}` },
	})
	const streamText = await stream.text()
	info(
		`durable stream /streams/sessions/:id (user token, sync proxy) -> ${stream.status}, ${streamText.length} bytes`,
	)
	block(
		streamText
			.slice(0, 2400)
			.split(/(?<=\})\s*,\s*(?=\{)|\n/)
			.filter(Boolean)
			.slice(0, 10),
	)

	const logs = await rpc(userToken, 'hosts/cloud/logs', { hostId, lines: 2000 })
	const daemonLog: string = logs.body?.daemon ?? ''
	const relevant = daemonLog
		.split('\n')
		.filter(
			(line) => /session|launch|claude|anthropic|login|auth|error|fail/i.test(line) && !/heartbeat/i.test(line),
		)
	const mentionsSession = daemonLog.includes(sessionId)
	info(
		`daemon log (hosts.cloud.logs): ${daemonLog.split('\n').length} lines, session id mentioned: ${mentionsSession}`,
	)
	block(relevant.slice(-40))

	const final = row?.status as string | undefined
	const agentAttempted =
		daemonTook &&
		(statuses.some((status) => status !== 'ready_for_launch' && status !== 'launching') || events.length > 0)
	check('daemon attempted to start the agent (session left launching, or the agent wrote events)', agentAttempted, {
		final,
		error: row?.error_message,
		errorReason: row?.error_reason,
		events: events.length,
	})
	stage(
		'agent start attempted',
		agentAttempted
			? `yes: final status ${final}${row?.error_message ? `, error "${row.error_message}"` : ''}`
			: 'no',
	)
	stage('conversation events', `${events.length} rows; stream ${stream.status} ${streamText.length} bytes`)
	// What the session page shows: its status, its error text, and the agent's last message.
	const lastAssistant = [...events].reverse().find((event: any) => event.role === 'assistant')?.content ?? null
	stage(
		'what the user sees',
		`status ${final}; error_message ${JSON.stringify(row?.error_message ?? null)}; last agent message ${JSON.stringify(lastAssistant)}`,
	)

	// 4. Agent sign-in probe
	if (!values['no-provider-login']) {
		const loginAt = Date.now()
		const login = await rpc(userToken, 'providerLogin/create', { hostId, provider: 'claude' })
		check('providerLogin.create (claude) accepted', login.status === 200, {
			status: login.status,
			error: login.status === 200 ? undefined : login.body,
		})
		loginRequestId = login.body?.requestId
		let loginRow: any
		const loginTransitions: string[] = []
		while (loginRequestId && Date.now() < loginAt + 120_000) {
			;[loginRow] =
				await sql`select status, url, user_code, error, account_label from provider_login_requests where id = ${loginRequestId}`
			if (loginRow && loginRow.status !== loginTransitions.at(-1)) {
				loginTransitions.push(loginRow.status)
				info(`provider login status -> ${loginRow.status}`)
			}
			if (loginRow && loginRow.status !== 'requested') break
			await sleep(1_000)
		}
		let urlSummary: unknown = null
		if (loginRow?.url) {
			const url = new URL(loginRow.url)
			// state and code_challenge are per-request values; print only the parameter names and the
			// two values that say which flow it is (`code=true` + a hosted redirect = paste-a-code flow).
			urlSummary = {
				origin: url.origin,
				path: url.pathname,
				queryParams: [...url.searchParams.keys()],
				code: url.searchParams.get('code'),
				redirectUri: url.searchParams.get('redirect_uri'),
			}
		}
		const gotUrl = loginRow?.status === 'awaiting_approval' && !!loginRow?.url
		check('daemon produced a Claude sign-in URL (awaiting_approval)', gotUrl, {
			statuses: loginTransitions,
			url: urlSummary,
			hasUserCode: !!loginRow?.user_code,
			error: loginRow?.error,
		})
		stage(
			'agent sign-in URL',
			gotUrl ? `yes: ${JSON.stringify(urlSummary)}` : `no: ${loginRow?.status} ${loginRow?.error ?? ''}`,
		)
		if (loginRequestId) {
			const cancelled = await rpc(userToken, 'providerLogin/cancel', { requestId: loginRequestId })
			info(`providerLogin.cancel -> ${cancelled.status}`)
		}
	}

	if (tails.length) {
		await sleep(5_000)
		// From host creation: the long-poll that delivers the session row starts before the launch.
		const traffic = summarizeDaemonTraffic(hostCreatedAt, Date.now())
		info(`daemon traffic seen by wrangler tail since host creation (${traffic.length} routes, first request time)`)
		block(traffic)
		const daemonCalls = tailEvents.filter((event) => event.at >= hostCreatedAt && isDaemonRequest(event))
		const sessionShape = daemonCalls.filter((event) => event.path.startsWith('/v1/sessions/'))
		const sessionUpdates = daemonCalls.filter(
			(event) => event.at >= launchAt && event.path.startsWith('/rpc/daemon/v1/sessions/update'),
		)
		check(
			'daemon subscribed to its sessions shape through the sync proxy (/v1/sessions/<hostId>)',
			sessionShape.length > 0,
			{
				requests: sessionShape.length,
				statuses: [...new Set(sessionShape.map((e) => e.status ?? e.outcome))],
			},
		)
		info(
			`daemon sessions.update calls after the launch: ${sessionUpdates.length}`,
			sessionUpdates.map((e) => `${elapsed(e.at)} ${e.status}`),
		)
		const failing = daemonCalls.filter(isFailure)
		check('no daemon request failed (status >= 400 or an error outcome)', failing.length === 0, failing.length)
		block(
			failing
				.slice(0, 15)
				.map(
					(e) =>
						`${elapsed(e.at)} ${e.worker} ${e.method} ${e.path} -> ${e.status} ${e.outcome} ${e.logs.join(' | ')}`,
				),
		)
		stage(
			'daemon traffic in tail',
			`${daemonCalls.length} requests (${sessionShape.length} sessions shape, ${sessionUpdates.length} sessions.update, ${failing.length} failed)`,
		)
	}
} catch (error) {
	check('run completed without an exception', false, String(error))
} finally {
	if (hostId && !destroyed) {
		const cleanup = await rpc(userToken, 'hosts/cloud/destroy', { hostId })
		destroyed = cleanup.body?.host?.status === 'destroyed'
		check('hosts.cloud.destroy', destroyed, cleanup.body?.host?.status ?? cleanup.body)
	}
	if (!values['keep-data']) {
		// Deleting the task cascades to its launch record and nulls sessions.task_id; deleting the session
		// cascades to its conversation events, approvals and usage rows.
		const deletedTasks = await sql`delete from tasks where id = ${taskId} returning id`
		const deletedSessions = await sql`delete from sessions where id = ${sessionId} returning id`
		// The launch stores the task content as the task's `task.md` artifact (Postgres storage, no FK).
		const deletedArtifacts = await sql`delete from artifacts where task_id = ${taskId} returning id`
		const deletedLogins = hostId
			? await sql`delete from provider_login_requests where host_id = ${hostId} returning id`
			: []
		// The first finished session stamps the user's `first_task_completed_at` onboarding milestone,
		// creating the user_settings row if there was none. Put it back as it was.
		const restoredSettings = !settingsBefore
			? await sql`delete from user_settings where user_id = ${userId} and organization_id = ${organizationId} returning user_id`
			: await sql`update user_settings set first_task_completed_at = ${settingsBefore.first_task_completed_at} where user_id = ${userId} and organization_id = ${organizationId} returning user_id`
		info('deleted test rows', {
			tasks: deletedTasks.length,
			sessions: deletedSessions.length,
			providerLogins: deletedLogins.length,
			artifacts: deletedArtifacts.length,
			userSettings: settingsBefore
				? `restored (${restoredSettings.length})`
				: `deleted (${restoredSettings.length})`,
		})
	}
	const live = await sql`select host_id, provider, status from cloud_hosts where status <> 'destroyed'`
	check('no live cloud_hosts rows', live.length === 0, live)
	const remaining = (await provisionerList()).filter((h) => h.providerState !== 'destroying')
	check(`no ${provider} hosts left on the provisioner`, remaining.length === 0, remaining)
	stopTails()
	await sql.close()
}

console.log('\nStages:')
for (const [name, result] of stages) console.log(`  ${name.padEnd(30)} ${redact(result)}`)
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED')
process.exit(fails ? 1 : 0)
