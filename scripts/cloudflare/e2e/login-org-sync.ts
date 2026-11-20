import { signIn, refresh, claims, bootstrapCredentials } from './auth-client'
import { API, SYNC } from './env'
let fails = 0
const check = (name: string, ok: boolean, detail?: unknown) => {
	if (!ok) fails++
	console.log(
		`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail).slice(0, 400)}`,
	)
}
async function rpc(token: string, path: string, input: unknown = {}) {
	const r = await fetch(`${API}/rpc/api/v1/${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	const text = await r.text()
	let body: any
	try {
		body = JSON.parse(text)
	} catch {
		body = text
	}
	return { status: r.status, body }
}
const { email, password } = await bootstrapCredentials()
let t = await signIn(email, password)
check('sign in via human-flare-auth', !!t.access_token, { claimKeys: Object.keys(claims(t.access_token)) })
let list = await rpc(t.access_token, 'auth/user/organizations/list')
check('API accepts user JWT (organizations.list)', list.status === 200, {
	status: list.status,
	body: list.status === 200 ? { count: list.body.organizations?.length } : list.body,
})
if (list.status === 200 && list.body.organizations.length === 0 && process.env.CREATE_ORG) {
	const created = await rpc(t.access_token, 'auth/user/organizations/create', {
		name: process.env.CREATE_ORG,
		domains: [],
		inviteEmails: [],
		eulaAccepted: true,
	})
	check('create organization (billing off)', created.status === 200, {
		status: created.status,
		body:
			created.status === 200
				? {
						organizationId: created.body.organizationId,
						stripeCustomerId: created.body.stripeCustomerId ?? null,
					}
				: created.body,
	})
	list = await rpc(t.access_token, 'auth/user/organizations/list')
}
const org = list.body?.organizations?.[0]
if (!org) {
	console.log('no organization; stopping')
	process.exit(fails ? 1 : 0)
}
// organizations.list returns the internal id; the token must be re-scoped with the WorkOS-side org id.
const signInUrl = new URL(org.signInUrl)
const workosOrgId = signInUrl.searchParams.get('organization_id') ?? org.organizationId
t = await refresh(t.refresh_token, workosOrgId)
const c = claims(t.access_token)
check('org-scoped token carries org_id + internal_org_id', !!c.org_id && !!c.internal_org_id, {
	org_id: c.org_id,
	internal_org_id: c.internal_org_id,
	role: c.role,
})
const info = await rpc(t.access_token, 'auth/user/info')
check('auth.user.info', info.status === 200, {
	status: info.status,
	body: info.status === 200 ? Object.keys(info.body) : info.body,
})
for (const p of ['/v2/tasks', '/v1/tasks', '/v3/hosts']) {
	const r = await fetch(`${SYNC}${p}?offset=-1`, { headers: { authorization: `Bearer ${t.access_token}` } })
	const body = await r.text()
	check(`sync proxy ${p} with user JWT -> 200`, r.status === 200, {
		status: r.status,
		handle: r.headers.get('electric-handle')?.slice(0, 12),
		body: body.slice(0, 120),
	})
}
console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED')
process.exit(fails ? 1 : 0)
