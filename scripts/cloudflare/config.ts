/**
 * Deployment settings for the Cloudflare stack, shared by the deploy script, the `wrangler` wrapper,
 * the CLI build (apps/cf-hosts/scripts/build-cli.ts) and the end-to-end checks.
 *
 * Tracked files hold no deployment-specific value. Every such value comes from the gitignored
 * `.env.cloudflare` at the repo root (see `.env.cloudflare.example` for the keys):
 *
 * - Each Worker's tracked `wrangler.jsonc` is a template. String values may contain `${NAME}`
 *   placeholders, resolved from {@link templateVars}. {@link renderWranglerConfig} writes the
 *   effective config to `<package>/wrangler.rendered.json` (gitignored), adds `account_id`, and
 *   refuses to write anything when a placeholder has no value.
 * - Every `wrangler` invocation that talks to Cloudflare uses the rendered file: the deploy script,
 *   and the package scripts through scripts/cloudflare/wrangler.ts.
 *
 * Origins default to `https://human-flare-<name>.<WORKERS_SUBDOMAIN>.workers.dev`; each one can be
 * overridden (`API_ORIGIN=https://api.example.com`), for custom domains.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
export const ENV_FILE = join(ROOT, '.env.cloudflare')
export const EXAMPLE_ENV_FILE = join(ROOT, '.env.cloudflare.example')
export const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler')
export const RENDERED_CONFIG_NAME = 'wrangler.rendered.json'

/** Public OAuth client id of the human-flare-auth Worker (apps/cf-auth). Not deployment-specific. */
export const AUTH_CLIENT_ID = 'client_humanlayer_cloudflare'

export class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------------
// .env.cloudflare

/** Parses KEY=value lines. Single quotes are literal; double quotes expand `\n`. */
export function parseEnvText(text: string): Record<string, string> {
	const result: Record<string, string> = {}
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
		if (!match) continue
		let value = match[2] ?? ''
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			const quote = value[0]
			value = value.slice(1, -1)
			if (quote === '"') value = value.replace(/\\n/g, '\n')
		}
		result[match[1] as string] = value
	}
	return result
}

/** The env file's values, or undefined when the file does not exist. */
export function readEnvFile(path: string = ENV_FILE): Record<string, string> | undefined {
	if (!existsSync(path)) return undefined
	return parseEnvText(readFileSync(path, 'utf8'))
}

/** Like {@link readEnvFile}, but a missing file is a {@link ConfigError} that says what to do. */
export function requireEnvFile(path: string = ENV_FILE): Record<string, string> {
	const env = readEnvFile(path)
	if (!env) {
		throw new ConfigError(
			`${relative(process.cwd(), path) || path} not found. Copy .env.cloudflare.example to .env.cloudflare ` +
				'at the repo root and fill in the required keys (see CLOUDFLARE.md).',
		)
	}
	return env
}

// ---------------------------------------------------------------------------------------------
// Derived settings

export const ORIGIN_KEYS = {
	api: 'API_ORIGIN',
	sync: 'SYNC_ORIGIN',
	app: 'APP_ORIGIN',
	cloud: 'CLOUD_ORIGIN',
	docs: 'DOCS_ORIGIN',
	auth: 'AUTH_ORIGIN',
	hosts: 'HOSTS_ORIGIN',
} as const

export type OriginName = keyof typeof ORIGIN_KEYS
export type Origins = Record<OriginName, string>

const WORKER_FOR_ORIGIN: Record<OriginName, string> = {
	api: 'human-flare-api',
	sync: 'human-flare-sync',
	app: 'human-flare-app',
	cloud: 'human-flare-cloud',
	docs: 'human-flare-docs',
	auth: 'human-flare-auth',
	hosts: 'human-flare-hosts',
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

/** Public origins: explicit `*_ORIGIN` keys win, otherwise derived from WORKERS_SUBDOMAIN. */
export function resolveOrigins(env: Record<string, string | undefined>): Origins {
	const subdomain = env.WORKERS_SUBDOMAIN?.trim()
	const out = {} as Origins
	const missing: string[] = []
	for (const [name, key] of Object.entries(ORIGIN_KEYS) as [OriginName, string][]) {
		const explicit = env[key]?.trim()
		if (explicit) out[name] = trimSlash(explicit)
		else if (subdomain) out[name] = `https://${WORKER_FOR_ORIGIN[name]}.${subdomain}.workers.dev`
		else missing.push(key)
	}
	if (missing.length > 0) {
		throw new ConfigError(`WORKERS_SUBDOMAIN is not set (needed for ${missing.join(', ')})`)
	}
	return out
}

/** The WorkOS-compatible auth settings every consumer uses (defaults: the human-flare-auth Worker). */
export function resolveAuth(env: Record<string, string | undefined>, origins: Origins = resolveOrigins(env)) {
	const apiHostname = env.WORKOS_API_HOSTNAME?.trim() || new URL(origins.auth).host
	const https = env.WORKOS_API_HTTPS?.trim() || ''
	const port = env.WORKOS_API_PORT?.trim() || ''
	const apiOrigin = `${https === 'false' ? 'http' : 'https'}://${apiHostname}${port ? `:${port}` : ''}`
	return {
		clientId: env.WORKOS_CLIENT_ID?.trim() || AUTH_CLIENT_ID,
		apiHostname,
		apiHttps: https,
		apiPort: port,
		/** Origin of the WorkOS-compatible API, e.g. for the CLI's device login. */
		apiOrigin,
		redirectUri: env.WORKOS_REDIRECT_URI?.trim() || origins.app,
		/** Management API key; defaults to the human-flare-auth Worker's API key. */
		apiKey: env.WORKOS_API_KEY || env.HUMANLAYER_AUTH_API_KEY || '',
		webhookSecret: env.WORKOS_WEBHOOK_SECRET || env.HUMANLAYER_AUTH_WEBHOOK_SECRET || '',
	}
}

/** Values with a default when the env file does not set them. */
const TEMPLATE_DEFAULTS: Record<string, string> = {
	// Cloudflare region the API runs in; pick the one closest to the Postgres primary.
	PLACEMENT_REGION: 'aws:us-east-1',
	IS_BILLING_ENFORCEMENT_ENABLED: 'false',
	AUTH_SIGNUP_ALLOWED_EMAILS: '',
	AUTH_SIGNUP_ALLOWED_DOMAINS: '',
	AUTH_EXTRA_REDIRECT_URIS: '',
	AUTH_WEBHOOK_URL: '',
	DAYTONA_API_URL: 'https://app.daytona.io/api',
}

/** Env keys that may appear as `${NAME}` in a wrangler.jsonc template, besides the origins. */
const TEMPLATE_ENV_KEYS = ['HYPERDRIVE_ID', 'BILLING_KV_ID', 'AUTH_D1_DATABASE_ID', ...Object.keys(TEMPLATE_DEFAULTS)]

/** Every value a wrangler.jsonc template can reference. Keys absent here are unresolved. */
export function templateVars(env: Record<string, string | undefined>): Record<string, string> {
	const origins = resolveOrigins(env)
	const auth = resolveAuth(env, origins)
	const vars: Record<string, string> = {}
	for (const key of TEMPLATE_ENV_KEYS) {
		const value = env[key]?.trim()
		if (value) vars[key] = value
		else if (key in TEMPLATE_DEFAULTS) vars[key] = TEMPLATE_DEFAULTS[key] as string
	}
	for (const [name, key] of Object.entries(ORIGIN_KEYS) as [OriginName, string][]) vars[key] = origins[name]
	vars.WORKOS_CLIENT_ID = auth.clientId
	vars.WORKOS_API_HOSTNAME = auth.apiHostname
	vars.WORKOS_REDIRECT_URI = auth.redirectUri
	return vars
}

// ---------------------------------------------------------------------------------------------
// JSONC and rendering

/** Strips // and block comments and trailing commas (string-aware), then JSON.parse. */
export function parseJsonc(text: string): unknown {
	let out = ''
	let inString = false
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string
		const next = text[i + 1]
		if (inString) {
			out += char
			if (char === '\\') {
				out += next ?? ''
				i++
			} else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
			out += char
		} else if (char === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n') i++
			out += '\n'
		} else if (char === '/' && next === '*') {
			i += 2
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
			i++
		} else out += char
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** Replaces `${NAME}` in every string of `value`; collects names without a value in `missing`. */
export function substitutePlaceholders(value: unknown, vars: Record<string, string>, missing: Set<string>): unknown {
	if (typeof value === 'string') {
		if (!value.includes('${')) return value
		const replaced = value.replace(PLACEHOLDER, (_match, name: string) => {
			const resolved = vars[name]
			if (resolved === undefined) {
				missing.add(name)
				return ''
			}
			return resolved
		})
		// Placeholders that resolve to '' leave doubled separators in space-separated lists.
		return replaced.replace(/\s+/g, ' ').trim()
	}
	if (Array.isArray(value)) return value.map((item) => substitutePlaceholders(item, vars, missing))
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, substitutePlaceholders(item, vars, missing)]),
		)
	}
	return value
}

/** Names of all `${NAME}` placeholders in a package's wrangler.jsonc. */
export function templatePlaceholders(packageDir: string): string[] {
	const text = readFileSync(join(packageDir, 'wrangler.jsonc'), 'utf8')
	return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string))]
}

export type WranglerConfig = {
	name?: string
	account_id?: string
	secrets?: { required?: string[] }
	containers?: { image?: string }[]
	main?: string
	[key: string]: unknown
}

export function readWranglerTemplate(packageDir: string): WranglerConfig {
	return parseJsonc(readFileSync(join(packageDir, 'wrangler.jsonc'), 'utf8')) as WranglerConfig
}

/**
 * Renders `<packageDir>/wrangler.jsonc` with `vars` into `<packageDir>/wrangler.rendered.json` and
 * returns its path. Throws {@link ConfigError} (writing nothing) when a placeholder is unresolved.
 */
export function renderWranglerConfig(
	packageDir: string,
	vars: Record<string, string>,
	accountId: string | undefined,
	options: { write?: boolean } = {},
): { path: string; config: WranglerConfig } {
	const template = readWranglerTemplate(packageDir)
	const missing = new Set<string>()
	const config = substitutePlaceholders(template, vars, missing) as WranglerConfig
	if (missing.size > 0) {
		throw new ConfigError(
			`${relative(ROOT, join(packageDir, 'wrangler.jsonc'))}: no value for ${[...missing].join(', ')} ` +
				'(set it in .env.cloudflare, or run the deploy script, which creates the resources and writes their ids)',
		)
	}
	if (!accountId) throw new ConfigError('CLOUDFLARE_ACCOUNT_ID is not set in .env.cloudflare')
	const rendered: WranglerConfig = { ...config, account_id: accountId }
	const path = join(packageDir, RENDERED_CONFIG_NAME)
	// Generated: do not edit or commit (gitignored). Plain JSON, so it carries no comment.
	if (options.write !== false) writeFileSync(path, `${JSON.stringify(rendered, null, '\t')}\n`)
	return { path, config: rendered }
}

/** Renders the config of the package in `packageDir` from the repo's .env.cloudflare. */
export function renderFromEnvFile(packageDir: string): { path: string; env: Record<string, string> } {
	const env = requireEnvFile()
	const { path } = renderWranglerConfig(packageDir, templateVars(env), env.CLOUDFLARE_ACCOUNT_ID)
	return { path, env }
}
