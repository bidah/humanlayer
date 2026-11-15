// Scripted AuthKit-style sign-in against the humanlayer-auth Worker (PKCE authorization-code flow).
// Used by the end-to-end checks in this directory; credentials come from the gitignored bootstrap file
// written by apps/cf-auth/scripts/bootstrap.ts (override the path with BOOTSTRAP_CREDENTIALS).
import { APP, AUTH, CLIENT_ID } from './env'

export { APP, AUTH, CLIENT_ID }
const dec = (s: string) =>
	s
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
function forms(html: string) {
	return [...html.matchAll(/<form([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => {
		const fields: Record<string, string> = {}
		for (const i of m[2]!.matchAll(/<input([^>]*)>/g)) {
			const n = /name="([^"]*)"/.exec(i[1]!)?.[1]
			if (n) fields[n] = dec(/value="([^"]*)"/.exec(i[1]!)?.[1] ?? '')
		}
		const selects: Record<string, string[]> = {}
		for (const s of m[2]!.matchAll(/<select[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g))
			selects[s[1]!] = [...s[2]!.matchAll(/<option value="([^"]*)"/g)].map((o) => dec(o[1]!))
		return { action: dec(/action="([^"]*)"/.exec(m[1]!)?.[1] ?? ''), fields, selects }
	})
}
class Jar {
	c = new Map<string, string>()
	absorb(r: Response) {
		for (const l of r.headers.getSetCookie()) {
			const p = l.split(';')[0]!
			const i = p.indexOf('=')
			this.c.set(p.slice(0, i).trim(), p.slice(i + 1).trim())
		}
	}
	h(): Record<string, string> {
		return this.c.size ? { cookie: [...this.c].map(([k, v]) => `${k}=${v}`).join('; ') } : {}
	}
}
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as any).toString('base64url')
export interface Tokens {
	access_token: string
	refresh_token: string
	user: any
	organization_id?: string
}
export async function signIn(email: string, password: string, organizationId?: string): Promise<Tokens> {
	const verifier = b64u(crypto.getRandomValues(new Uint8Array(48)))
	const challenge = b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
	const q = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: 'code',
		provider: 'authkit',
		redirect_uri: APP,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state: 'e2e',
	})
	if (organizationId) q.set('organization_id', organizationId)
	const jar = new Jar()
	let r = await fetch(`${AUTH}/user_management/authorize?${q}`, { redirect: 'manual', headers: jar.h() })
	jar.absorb(r)
	let html = await r.text()
	if (r.status !== 200) throw new Error(`authorize page ${r.status}: ${html.slice(0, 300)}`)
	const cred = forms(html).find((f) => f.fields.intent === 'sign_in' || f.fields.intent === 'sign_up')
	if (!cred) throw new Error('no credentials form')
	const post = async (action: string, fields: Record<string, string>) => {
		const res = await fetch(new URL(action, AUTH), {
			method: 'POST',
			redirect: 'manual',
			headers: { ...jar.h(), 'content-type': 'application/x-www-form-urlencoded', origin: AUTH },
			body: new URLSearchParams(fields),
		})
		jar.absorb(res)
		return res
	}
	r = await post(cred.action, { ...cred.fields, intent: 'sign_in', email, password })
	if (r.status === 200) {
		html = await r.text()
		const picker = forms(html).find((f) => f.fields.intent === 'continue')
		if (!picker)
			throw new Error(
				`unexpected page after sign-in: ${html
					.replace(/<[^>]+>/g, ' ')
					.replace(/\s+/g, ' ')
					.slice(0, 300)}`,
			)
		const choice = organizationId ?? picker.selects.organization_choice?.[0]
		r = await post(picker.action, { ...picker.fields, ...(choice ? { organization_choice: choice } : {}) })
	}
	if (r.status !== 303 && r.status !== 302)
		throw new Error(
			`sign-in did not redirect: ${r.status} ${(await r.text())
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.slice(0, 300)}`,
		)
	const code = new URL(r.headers.get('location')!).searchParams.get('code')
	if (!code) throw new Error('no code in redirect')
	const t = await fetch(`${AUTH}/user_management/authenticate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: APP },
		body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'authorization_code', code, code_verifier: verifier }),
	})
	if (!t.ok) throw new Error(`code exchange ${t.status}: ${await t.text()}`)
	return (await t.json()) as Tokens
}
export async function refresh(refreshToken: string, organizationId?: string): Promise<Tokens> {
	const t = await fetch(`${AUTH}/user_management/authenticate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: APP },
		body: JSON.stringify({
			client_id: CLIENT_ID,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			...(organizationId ? { organization_id: organizationId } : {}),
		}),
	})
	if (!t.ok) throw new Error(`refresh ${t.status}: ${await t.text()}`)
	return (await t.json()) as Tokens
}
export const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString())
export async function bootstrapCredentials(): Promise<{ email: string; password: string }> {
	const path =
		process.env.BOOTSTRAP_CREDENTIALS ?? `${import.meta.dir}/../../../apps/cf-auth/.bootstrap-credentials.json`
	const raw = JSON.parse(await Bun.file(path).text())
	const e = Array.isArray(raw) ? raw[raw.length - 1] : raw
	return { email: e.email, password: e.password }
}
