// Plain server-rendered HTML for the hosted pages. No scripts; every dynamic value is escaped.

export function esc(value: string | number | null | undefined): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--border:#d9d9d4;--accent:#1d1d1b;--accent-fg:#fff;--err:#a4251c;--errbg:#fbeceb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ededea;--muted:#a3a39d;--border:#3a3a37;--accent:#ededea;--accent-fg:#141413;--err:#f2a39c;--errbg:#3a1d1a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;margin:8vh auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:28px}
h1{font-size:1.35rem;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}
label{display:block;font-size:.9rem;margin:16px 0 6px}
input[type=email],input[type=password],input[type=text],select{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:transparent;color:inherit;font:inherit}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:6px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--border)}
.error{background:var(--errbg);color:var(--err);border-radius:6px;padding:10px 12px;margin:12px 0}
.links{margin-top:18px;font-size:.9rem}a{color:inherit}
table{width:100%;border-collapse:collapse;font-size:.85rem}td,th{border-bottom:1px solid var(--border);padding:6px 4px;text-align:left;vertical-align:top}
code{word-break:break-all;font-size:.8rem}
.code{font:600 1.6rem/1 ui-monospace,monospace;letter-spacing:.15em;text-align:center;margin:16px 0}
`

export const PAGE_HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
	'x-frame-options': 'DENY',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
}

export function page(title: string, inner: string, status = 200, extraHeaders: HeadersInit = {}): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${inner}</div></main></body></html>`
	const headers = new Headers(PAGE_HEADERS)
	for (const [k, v] of new Headers(extraHeaders)) headers.append(k, v)
	return new Response(html, { status, headers })
}

export function hidden(fields: Record<string, string | undefined>): string {
	return Object.entries(fields)
		.filter(([, v]) => v !== undefined && v !== '')
		.map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
		.join('')
}

export const errorBox = (message?: string) => (message ? `<div class="error" role="alert">${esc(message)}</div>` : '')

export function messagePage(title: string, message: string, status = 200, extraHeaders: HeadersInit = {}): Response {
	return page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, status, extraHeaders)
}

export interface CredentialsFormOptions {
	action: string
	mode: 'sign_in' | 'sign_up'
	csrf: string
	hiddenFields: Record<string, string | undefined>
	email?: string
	emailLocked?: boolean
	error?: string
	heading?: string
	subheading?: string
	/** URL that renders the other mode (sign-in <-> sign-up). */
	switchUrl?: string
}

export function credentialsForm(o: CredentialsFormOptions): string {
	const signUp = o.mode === 'sign_up'
	return `<h1>${esc(o.heading ?? (signUp ? 'Create your account' : 'Sign in'))}</h1>
<p class="muted">${esc(o.subheading ?? 'HumanLayer')}</p>
${errorBox(o.error)}
<form method="post" action="${esc(o.action)}">
${hidden({ ...o.hiddenFields, csrf_token: o.csrf, intent: o.mode })}
${
	signUp
		? `<label for="first_name">First name</label><input id="first_name" name="first_name" type="text" autocomplete="given-name" maxlength="100">
<label for="last_name">Last name</label><input id="last_name" name="last_name" type="text" autocomplete="family-name" maxlength="100">`
		: ''
}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required value="${esc(o.email)}"${o.emailLocked ? ' readonly' : ''}>
<label for="password">Password${signUp ? ' (at least 10 characters)' : ''}</label>
<input id="password" name="password" type="password" autocomplete="${signUp ? 'new-password' : 'current-password'}" required minlength="${signUp ? 10 : 1}" maxlength="256">
<button type="submit">${signUp ? 'Create account' : 'Sign in'}</button>
</form>
${o.switchUrl ? `<p class="links">${signUp ? 'Already have an account?' : 'Have an invitation?'} <a href="${esc(o.switchUrl)}">${signUp ? 'Sign in' : 'Create an account'}</a></p>` : ''}`
}

export interface OrgChoice {
	id: string
	name: string
}

export function continueForm(o: {
	action: string
	csrf: string
	email: string
	hiddenFields: Record<string, string | undefined>
	organizations?: OrgChoice[]
	heading: string
	subheading?: string
	submitLabel: string
	error?: string
	switchAccountUrl: string
	denyLabel?: string
}): string {
	const orgSelect =
		o.organizations && o.organizations.length > 1
			? `<label for="organization_choice">Organization</label><select id="organization_choice" name="organization_choice" required>${o.organizations
					.map((org) => `<option value="${esc(org.id)}">${esc(org.name)}</option>`)
					.join('')}</select>`
			: ''
	return `<h1>${esc(o.heading)}</h1>
${o.subheading ? `<p class="muted">${esc(o.subheading)}</p>` : ''}
<p>Signed in as <strong>${esc(o.email)}</strong>.</p>
${errorBox(o.error)}
<form method="post" action="${esc(o.action)}">
${hidden({ ...o.hiddenFields, csrf_token: o.csrf, intent: 'continue' })}
${orgSelect}
<button type="submit">${esc(o.submitLabel)}</button>
</form>
${
	o.denyLabel
		? `<form method="post" action="${esc(o.action)}">${hidden({ ...o.hiddenFields, csrf_token: o.csrf, intent: 'deny' })}<button type="submit" class="secondary">${esc(o.denyLabel)}</button></form>`
		: ''
}
<form method="post" action="${esc(o.switchAccountUrl)}">${hidden({ csrf_token: o.csrf })}<button type="submit" class="secondary">Use a different account</button></form>`
}
