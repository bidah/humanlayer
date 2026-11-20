#!/usr/bin/env bun
/**
 * Stands up or updates the whole HumanLayer stack on Cloudflare. Idempotent: every step can be
 * re-run, and a re-run against a working deployment changes no resource and no secret.
 *
 *   bun scripts/cloudflare/deploy.ts                       # everything
 *   bun scripts/cloudflare/deploy.ts --only electric,jobs  # a subset of Workers
 *   bun scripts/cloudflare/deploy.ts --only sites          # app, cloud and docs
 *   bun scripts/cloudflare/deploy.ts --dry-run             # check and validate; change nothing
 *   bun scripts/cloudflare/deploy.ts --list                # targets, origins and resource ids
 *
 * Flags: --only <names>, --skip-migrations, --skip-build (reuse existing site builds), --skip-cli
 * (do not build/upload the CLI for cloud hosts), --dry-run (no resource creation, no env file
 * writes, no migrations, no uploads; `wrangler deploy --dry-run` bundles and validates each Worker).
 *
 * Steps, in order:
 *  1. Read .env.cloudflare (template: .env.cloudflare.example). Required: CLOUDFLARE_ACCOUNT_ID,
 *     WORKERS_SUBDOMAIN, DATABASE_URL (Postgres 18, wal_level=logical).
 *  2. Check wrangler login, container images, and the Postgres version and wal_level.
 *  3. Ensure the account resources (Hyperdrive config, KV namespace, R2 bucket, D1 database,
 *     Queues), found by name, created when missing. New ids are appended to .env.cloudflare.
 *  4. Ensure the generated secrets. A missing one is generated and appended to .env.cloudflare,
 *     unless a Worker that uses it already has it set: an existing secret is never replaced.
 *  5. Run the Postgres migrations (packages/db, drizzle-kit) and the D1 migrations (apps/cf-auth).
 *  6. Render each Worker's wrangler.jsonc template to wrangler.rendered.json (scripts/cloudflare/config.ts).
 *  7. Build the CLI with this deployment baked in and publish it to R2 for cloud hosts, unless the
 *     published build already matches (apps/cf-hosts/scripts/build-cli.ts --if-changed).
 *  8. Build the sites and deploy every Worker in dependency order. Each Worker's secrets are the
 *     names in its wrangler.jsonc `secrets.required` (wrangler refuses to deploy without them),
 *     plus the optional names below that are set; they are uploaded with the code through
 *     `wrangler deploy --secrets-file` (a 0600 file in a 0700 temp dir, deleted afterwards).
 *  9. Print the URLs and the remaining manual step (the first user).
 *
 * Secret values are never printed: all child process output passes through a redactor.
 * No Docker anywhere: container images must be registry references, never Dockerfiles.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	ConfigError,
	ENV_FILE,
	ROOT,
	WRANGLER,
	type WranglerConfig,
	readEnvFile,
	readWranglerTemplate,
	renderWranglerConfig,
	requireEnvFile,
	resolveAuth,
	resolveOrigins,
	templateVars,
} from './config'
import { docsHeadersFile, spaHeadersFile } from './headers'

type TargetName =
	| 'streams'
	| 'electric'
	| 'hosts'
	| 'auth'
	| 'api'
	| 'sync'
	| 'jobs'
	| 'app'
	| 'cloud'
	| 'docs'

type Target = {
	name: TargetName
	worker: string
	dir: string
	site?: 'app' | 'cloud' | 'docs'
	/** Optional Worker secrets: uploaded when the value is set, silently skipped otherwise. */
	optionalSecrets?: string[]
}

/** Names the API reads for optional integrations (each one degrades to "not configured"). */
const API_OPTIONAL_SECRETS = [
	'STRIPE_SECRET_KEY',
	'STRIPE_WEBHOOK_SECRET',
	'STRIPE_PRICE_STARTER',
	'STRIPE_PRICE_PRO',
	'STRIPE_PRICE_ENTERPRISE',
	'RESEND_API_KEY',
	'RESEND_WEBHOOK_SECRET',
	'RESEND_FROM_EMAIL',
	'RESEND_PRODUCT_USERS_SEGMENT_ID',
	'GITHUB_APP_ID',
	'GITHUB_APP_CLIENT_ID',
	'GITHUB_APP_SLUG',
	'GITHUB_APP_PRIVATE_KEY',
	'GITHUB_APP_WEBHOOK_SECRET',
	'SLACK_APP_ID',
	'SLACK_CLIENT_ID',
	'SLACK_CLIENT_SECRET',
	'SLACK_SIGNING_SECRET',
	'SLACK_OAUTH_REDIRECT_URL',
	'JIRA_CLIENT_ID',
	'JIRA_CLIENT_SECRET',
	'JIRA_OAUTH_REDIRECT_URL',
	'LINEAR_CLIENT_ID',
	'LINEAR_CLIENT_SECRET',
	'LINEAR_OAUTH_REDIRECT_URL',
	'ANTHROPIC_API_KEY',
	'OPENAI_API_KEY',
	'EXA_API_KEY',
	'CONTEXT7_API_KEY',
	'SENTRY_DSN',
	'POSTHOG_API_KEY',
	'POSTHOG_HOST',
]

/**
 * Dependency order: a service binding needs its target Worker to exist, so on a first deploy each
 * Worker comes after the Workers it binds (api -> streams, hosts; sync -> electric, streams;
 * jobs -> hosts). The sites only need the origins.
 */
const TARGETS: readonly Target[] = [
	{ name: 'streams', worker: 'human-flare-streams', dir: 'apps/cf-durable-streams' },
	{ name: 'electric', worker: 'human-flare-electric', dir: 'apps/cf-electric' },
	{
		name: 'hosts',
		worker: 'human-flare-hosts',
		dir: 'apps/cf-hosts',
		optionalSecrets: ['DAYTONA_API_KEY', 'E2B_API_KEY', 'E2B_TEMPLATE'],
	},
	{ name: 'auth', worker: 'human-flare-auth', dir: 'apps/cf-auth', optionalSecrets: ['SIGNING_KEY_JWK_PREVIOUS'] },
	{ name: 'api', worker: 'human-flare-api', dir: 'apps/riptide-api', optionalSecrets: API_OPTIONAL_SECRETS },
	{ name: 'sync', worker: 'human-flare-sync', dir: 'apps/riptide-electric-proxy', optionalSecrets: ['SENTRY_DSN'] },
	{ name: 'jobs', worker: 'human-flare-jobs', dir: 'apps/cf-jobs' },
	// riptide-cloud before riptide-ui, as in the reference deploy order.
	{ name: 'cloud', worker: 'human-flare-cloud', dir: 'apps/riptide-cloud', site: 'cloud' },
	{ name: 'app', worker: 'human-flare-app', dir: 'apps/riptide-ui', site: 'app' },
	{ name: 'docs', worker: 'human-flare-docs', dir: 'apps/docs', site: 'docs' },
]

const ALIASES: Record<string, TargetName[]> = { sites: ['cloud', 'app', 'docs'] }

/** Account resources of this stack. Only these names are ever looked up or created. */
const RESOURCES = {
	hyperdrive: 'human-flare-db',
	kv: 'human-flare-billing-cache',
	r2: 'human-flare-artifacts',
	d1: 'human-flare-auth',
	queues: ['human-flare-background-dlq', 'human-flare-background'],
} as const

/** Placeholder ids used only to render configs for `--dry-run` when a resource does not exist yet. */
const DRY_RUN_IDS = {
	HYPERDRIVE_ID: '00000000000000000000000000000000',
	BILLING_KV_ID: '00000000000000000000000000000000',
	AUTH_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000000',
}

// ---------------------------------------------------------------------------------------------
// Output with secret redaction

let secretValues: string[] = []

/** Keys whose values are public identifiers (shown in output, never redacted). */
const PUBLIC_KEYS = new Set([
	'CLOUDFLARE_ACCOUNT_ID',
	'WORKERS_SUBDOMAIN',
	'HYPERDRIVE_ID',
	'BILLING_KV_ID',
	'AUTH_D1_DATABASE_ID',
	'NEON_PROJECT_ID',
	'WORKOS_CLIENT_ID',
	'WORKOS_API_HOSTNAME',
	'WORKOS_API_HTTPS',
	'WORKOS_API_PORT',
	'WORKOS_REDIRECT_URI',
	'DAYTONA_API_URL',
	'PLACEMENT_REGION',
	'IS_BILLING_ENFORCEMENT_ENABLED',
	'AUTH_SIGNUP_ALLOWED_EMAILS',
	'AUTH_SIGNUP_ALLOWED_DOMAINS',
	'AUTH_EXTRA_REDIRECT_URIS',
	'AUTH_WEBHOOK_URL',
	'CLI_TARGETS',
])
const isPublicKey = (key: string) => PUBLIC_KEYS.has(key) || key.endsWith('_ORIGIN')

function addSecretValue(value: string) {
	if (value.length < 8) return
	secretValues.push(value)
	secretValues.sort((a, b) => b.length - a.length)
}

function redact(text: string): string {
	let out = text
	for (const value of secretValues) out = out.split(value).join('[redacted]')
	return out
}

const log = (message: string) => console.log(redact(message))
const warn = (message: string) => console.warn(redact(`\x1b[33m${message}\x1b[0m`))
const step = (message: string) => console.log(`\n\x1b[1;36m==> ${message}\x1b[0m`)

class DeployError extends Error {}

// ---------------------------------------------------------------------------------------------
// Child processes

type RunOptions = {
	cwd?: string
	env?: Record<string, string | undefined>
	quiet?: boolean
	/** Resolve instead of throwing on a non-zero exit. */
	allowFailure?: boolean
}

async function run(command: string[], options: RunOptions = {}): Promise<{ code: number; output: string }> {
	const proc = Bun.spawn(command, {
		cwd: options.cwd ?? ROOT,
		env: options.env ?? childEnv(),
		stdout: 'pipe',
		stderr: 'pipe',
		stdin: 'ignore',
	})
	let captured = ''
	const pump = async (stream: ReadableStream<Uint8Array>, write: (text: string) => void) => {
		const decoder = new TextDecoder()
		let buffer = ''
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop() ?? ''
			for (const line of lines) {
				captured += `${line}\n`
				if (!options.quiet) write(redact(line))
			}
		}
		if (buffer) {
			captured += buffer
			if (!options.quiet) write(redact(buffer))
		}
	}
	await Promise.all([
		pump(proc.stdout, (text) => console.log(`    ${text}`)),
		pump(proc.stderr, (text) => console.error(`    ${text}`)),
	])
	const code = await proc.exited
	if (code !== 0 && !options.allowFailure) {
		if (options.quiet) console.error(redact(captured.split('\n').slice(-30).join('\n')))
		// The command line can hold a connection string: print only the program and subcommand.
		throw new DeployError(`Command failed (${code}): ${command.slice(0, 3).join(' ')} ...`)
	}
	return { code, output: redact(captured) }
}

/** wrangler run outside any package (no config file): account-level resource commands. */
const RESOURCE_CWD = mkdtempSync(join(tmpdir(), 'hl-cf-wrangler-'))
const wrangler = (args: string[], options: RunOptions = {}) =>
	run([WRANGLER, ...args], { cwd: RESOURCE_CWD, quiet: true, ...options })

let env: Record<string, string> = {}

/** Environment for child processes: the parent env minus every .env.cloudflare key. */
function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	const base: Record<string, string | undefined> = { ...process.env }
	for (const key of Object.keys(env)) delete base[key]
	return {
		...base,
		CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
		WRANGLER_SEND_METRICS: 'false',
		...extra,
	}
}

// ---------------------------------------------------------------------------------------------
// .env.cloudflare writes (append only: an existing line is never rewritten)

const envWrites: string[] = []

function appendEnv(key: string, value: string, dryRun: boolean) {
	if (env[key]) throw new DeployError(`refusing to overwrite ${key} in .env.cloudflare`)
	if (value.includes("'") || value.includes('\n')) throw new DeployError(`${key}: value cannot be single-quoted`)
	env[key] = value
	if (dryRun) return
	const existing = readFileSync(ENV_FILE, 'utf8')
	let text = existing === '' || existing.endsWith('\n') ? '' : '\n'
	if (envWrites.length === 0) text += `\n# Written by scripts/cloudflare/deploy.ts on ${new Date().toISOString()}\n`
	appendFileSync(ENV_FILE, `${text}${key}='${value}'\n`)
	chmodSync(ENV_FILE, 0o600)
	envWrites.push(key)
}

// ---------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv: string[]) {
	const flags = {
		only: undefined as TargetName[] | undefined,
		skipMigrations: false,
		skipBuild: false,
		skipCli: false,
		dryRun: false,
		list: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (arg === '--only' || arg.startsWith('--only=')) {
			const value = arg.includes('=') ? arg.slice('--only='.length) : argv[++i]
			if (!value) throw new DeployError('--only needs a comma-separated list')
			const resolved: TargetName[] = []
			for (const name of value
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean)) {
				for (const item of ALIASES[name] ?? [name]) {
					if (!TARGETS.some((target) => target.name === item)) {
						throw new DeployError(
							`Unknown target "${item}". Known: ${TARGETS.map((t) => t.name).join(', ')}, sites`,
						)
					}
					resolved.push(item as TargetName)
				}
			}
			flags.only = resolved
		} else if (arg === '--skip-migrations') flags.skipMigrations = true
		else if (arg === '--skip-build') flags.skipBuild = true
		else if (arg === '--skip-cli') flags.skipCli = true
		else if (arg === '--dry-run') flags.dryRun = true
		else if (arg === '--list') flags.list = true
		else if (arg === '--help' || arg === '-h') {
			console.log(readFileSync(import.meta.path, 'utf8').split('*/')[0])
			process.exit(0)
		} else throw new DeployError(`Unknown argument ${arg}`)
	}
	return flags
}

// ---------------------------------------------------------------------------------------------
// Checks

async function checkPrerequisites(selected: Target[]) {
	step('Checking prerequisites')
	if (!existsSync(WRANGLER)) throw new DeployError(`wrangler not found at ${WRANGLER}; run bun install`)
	const version = (await wrangler(['--version'])).output.trim().split('\n').pop()
	log(`    wrangler ${version}`)
	const whoami = (await wrangler(['whoami'])).output
	if (!whoami.includes(env.CLOUDFLARE_ACCOUNT_ID as string)) {
		throw new DeployError(
			`wrangler is not logged in to account ${env.CLOUDFLARE_ACCOUNT_ID} (run node_modules/.bin/wrangler login)`,
		)
	}
	log(`    authenticated; account ${env.CLOUDFLARE_ACCOUNT_ID}`)
	for (const target of selected) {
		for (const container of readWranglerTemplate(join(ROOT, target.dir)).containers ?? []) {
			if (!container.image || /dockerfile/i.test(container.image) || container.image.startsWith('.')) {
				throw new DeployError(
					`${target.worker}: container image "${container.image}" needs a Docker build; use a registry reference`,
				)
			}
		}
	}
}

async function checkPostgres() {
	step('Checking Postgres (DATABASE_URL)')
	const sql = new Bun.SQL(env.DATABASE_URL as string)
	try {
		const [row] = (await sql`select current_setting('server_version_num')::int as version, current_setting('wal_level') as wal_level`) as {
			version: number
			wal_level: string
		}[]
		if (!row) throw new DeployError('could not read server settings')
		log(`    server_version_num ${row.version}, wal_level ${row.wal_level}`)
		if (row.version < 180000) {
			throw new DeployError(`Postgres ${Math.floor(row.version / 10000)} found; this stack needs Postgres 18`)
		}
		if (row.wal_level !== 'logical') {
			throw new DeployError(
				'wal_level is not "logical": Electric needs logical replication (on Neon: Project settings > Logical Replication)',
			)
		}
	} catch (error) {
		if (error instanceof DeployError) throw error
		throw new DeployError(`cannot connect to DATABASE_URL: ${redact(String(error))}`)
	} finally {
		await sql.close()
	}
}

// ---------------------------------------------------------------------------------------------
// Resources

/** Rows of a wrangler box-drawing table, as arrays of trimmed cells. */
function tableRows(output: string): string[][] {
	return output
		.split('\n')
		.filter((line) => line.includes('│'))
		.map((line) =>
			line
				.split('│')
				.map((cell) => cell.trim())
				.filter((_cell, index, cells) => index > 0 && index < cells.length - 1),
		)
}

async function hyperdriveIdByName(): Promise<string | undefined> {
	const rows = tableRows((await wrangler(['hyperdrive', 'list'])).output)
	return rows.find((cells) => cells[1] === RESOURCES.hyperdrive)?.[0]
}

async function ensureHyperdrive(dryRun: boolean) {
	if (env.HYPERDRIVE_ID) {
		const result = await wrangler(['hyperdrive', 'get', env.HYPERDRIVE_ID], { allowFailure: true })
		if (result.code !== 0) {
			throw new DeployError(`HYPERDRIVE_ID ${env.HYPERDRIVE_ID} from .env.cloudflare does not exist on the account`)
		}
		log(`    hyperdrive  ${RESOURCES.hyperdrive}: exists (${env.HYPERDRIVE_ID})`)
		return
	}
	let id = await hyperdriveIdByName()
	if (id) log(`    hyperdrive  ${RESOURCES.hyperdrive}: exists (${id})`)
	else if (dryRun) {
		log(`    hyperdrive  ${RESOURCES.hyperdrive}: would be created`)
		env.HYPERDRIVE_ID = DRY_RUN_IDS.HYPERDRIVE_ID
		return
	} else {
		// Uses the direct (non-pooled) URL, without query cache: the API reads its own writes.
		await wrangler([
			'hyperdrive',
			'create',
			RESOURCES.hyperdrive,
			`--connection-string=${env.DATABASE_URL}`,
			'--caching-disabled',
		])
		id = await hyperdriveIdByName()
		if (!id) throw new DeployError('Hyperdrive config was created but is not listed')
		log(`    hyperdrive  ${RESOURCES.hyperdrive}: created (${id})`)
	}
	appendEnv('HYPERDRIVE_ID', id, dryRun)
}

async function kvNamespaces(): Promise<{ id: string; title: string }[]> {
	const output = (await wrangler(['kv', 'namespace', 'list'])).output
	return JSON.parse(output.slice(output.indexOf('['))) as { id: string; title: string }[]
}

async function ensureKv(dryRun: boolean) {
	const namespaces = await kvNamespaces()
	if (env.BILLING_KV_ID) {
		if (!namespaces.some((ns) => ns.id === env.BILLING_KV_ID)) {
			throw new DeployError(`BILLING_KV_ID ${env.BILLING_KV_ID} from .env.cloudflare does not exist on the account`)
		}
		log(`    kv          ${RESOURCES.kv}: exists (${env.BILLING_KV_ID})`)
		return
	}
	let id = namespaces.find((ns) => ns.title === RESOURCES.kv)?.id
	if (id) log(`    kv          ${RESOURCES.kv}: exists (${id})`)
	else if (dryRun) {
		log(`    kv          ${RESOURCES.kv}: would be created`)
		env.BILLING_KV_ID = DRY_RUN_IDS.BILLING_KV_ID
		return
	} else {
		await wrangler(['kv', 'namespace', 'create', RESOURCES.kv, '--update-config=false'])
		id = (await kvNamespaces()).find((ns) => ns.title === RESOURCES.kv)?.id
		if (!id) throw new DeployError('KV namespace was created but is not listed')
		log(`    kv          ${RESOURCES.kv}: created (${id})`)
	}
	appendEnv('BILLING_KV_ID', id, dryRun)
}

async function ensureR2(dryRun: boolean) {
	const info = await wrangler(['r2', 'bucket', 'info', RESOURCES.r2, '--json'], { allowFailure: true })
	if (info.code === 0) return log(`    r2          ${RESOURCES.r2}: exists`)
	if (dryRun) return log(`    r2          ${RESOURCES.r2}: would be created`)
	await wrangler(['r2', 'bucket', 'create', RESOURCES.r2, '--update-config=false'])
	log(`    r2          ${RESOURCES.r2}: created`)
}

async function d1Databases(): Promise<{ uuid: string; name: string }[]> {
	const output = (await wrangler(['d1', 'list', '--json'])).output
	return JSON.parse(output.slice(output.indexOf('['))) as { uuid: string; name: string }[]
}

async function ensureD1(dryRun: boolean) {
	const databases = await d1Databases()
	if (env.AUTH_D1_DATABASE_ID) {
		if (!databases.some((db) => db.uuid === env.AUTH_D1_DATABASE_ID)) {
			throw new DeployError(
				`AUTH_D1_DATABASE_ID ${env.AUTH_D1_DATABASE_ID} from .env.cloudflare does not exist on the account`,
			)
		}
		log(`    d1          ${RESOURCES.d1}: exists (${env.AUTH_D1_DATABASE_ID})`)
		return
	}
	let id = databases.find((db) => db.name === RESOURCES.d1)?.uuid
	if (id) log(`    d1          ${RESOURCES.d1}: exists (${id})`)
	else if (dryRun) {
		log(`    d1          ${RESOURCES.d1}: would be created`)
		env.AUTH_D1_DATABASE_ID = DRY_RUN_IDS.AUTH_D1_DATABASE_ID
		return
	} else {
		await wrangler(['d1', 'create', RESOURCES.d1, '--update-config=false'])
		id = (await d1Databases()).find((db) => db.name === RESOURCES.d1)?.uuid
		if (!id) throw new DeployError('D1 database was created but is not listed')
		log(`    d1          ${RESOURCES.d1}: created (${id})`)
	}
	appendEnv('AUTH_D1_DATABASE_ID', id, dryRun)
}

async function ensureQueues(dryRun: boolean) {
	// The dead-letter queue first: the consumer config of human-flare-background references it.
	for (const queue of RESOURCES.queues) {
		const info = await wrangler(['queues', 'info', queue], { allowFailure: true })
		if (info.code === 0) log(`    queue       ${queue}: exists`)
		else if (!/does not exist/i.test(info.output)) throw new DeployError(`wrangler queues info ${queue} failed`)
		else if (dryRun) log(`    queue       ${queue}: would be created`)
		else {
			await wrangler(['queues', 'create', queue])
			log(`    queue       ${queue}: created`)
		}
	}
}

async function ensureResources(dryRun: boolean) {
	step(`Ensuring account resources${dryRun ? ' (dry run: nothing is created)' : ''}`)
	await ensureHyperdrive(dryRun)
	await ensureKv(dryRun)
	await ensureR2(dryRun)
	await ensureD1(dryRun)
	await ensureQueues(dryRun)
}

// ---------------------------------------------------------------------------------------------
// Secrets

const remoteSecretCache = new Map<string, Set<string>>()

/** Names of the secrets set on a deployed Worker (empty when the Worker does not exist yet). */
async function remoteSecretNames(worker: string): Promise<Set<string>> {
	const cached = remoteSecretCache.get(worker)
	if (cached) return cached
	const result = await wrangler(['secret', 'list', '--name', worker, '--format', 'json'], { allowFailure: true })
	let names = new Set<string>()
	if (result.code === 0) {
		const start = result.output.indexOf('[')
		names = new Set((JSON.parse(result.output.slice(start)) as { name: string }[]).map((secret) => secret.name))
	}
	remoteSecretCache.set(worker, names)
	return names
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const base64url = (bytes: number) => randomBytes(bytes).toString('base64url')

function rsaPemPairBase64(): string[] {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	})
	return [Buffer.from(privateKey).toString('base64'), Buffer.from(publicKey).toString('base64')]
}

async function signingJwk(): Promise<string> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
	const kid = `hl_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${base64url(4)}`
	return JSON.stringify({ ...jwk, alg: 'RS256', kid })
}

type GeneratedSecret = {
	/** .env.cloudflare keys generated together. */
	keys: string[]
	make: () => Promise<string[]> | string[]
	/** Worker secrets that hold these values: [worker, secret name]. */
	usedBy: [worker: string, secret: string][]
}

const GENERATED_SECRETS: GeneratedSecret[] = [
	{
		keys: ['RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY', 'RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY'],
		make: rsaPemPairBase64,
		usedBy: [
			['human-flare-api', 'RIPTIDE_DAEMON_TOKEN_PRIVATE_KEY'],
			['human-flare-api', 'RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY'],
			['human-flare-sync', 'RIPTIDE_DAEMON_TOKEN_PUBLIC_KEY'],
		],
	},
	{
		keys: ['ELECTRIC_SECRET'],
		make: () => [hex(32)],
		usedBy: [
			['human-flare-electric', 'ELECTRIC_SECRET'],
			['human-flare-sync', 'ELECTRIC_SECRET'],
		],
	},
	{
		keys: ['INTERNAL_SERVICE_SECRET'],
		make: () => [hex(32)],
		usedBy: [
			['human-flare-api', 'INTERNAL_SERVICE_SECRET'],
			['human-flare-electric', 'INTERNAL_SERVICE_SECRET'],
			['human-flare-jobs', 'INTERNAL_SERVICE_SECRET'],
			['human-flare-hosts', 'INTERNAL_SERVICE_SECRET'],
		],
	},
	{
		keys: ['ARTIFACT_URL_SIGNING_SECRET'],
		make: () => [hex(32)],
		usedBy: [['human-flare-api', 'ARTIFACT_URL_SIGNING_SECRET']],
	},
	{
		keys: ['HUMANLAYER_AUTH_API_KEY'],
		make: () => [`sk_hl_${base64url(32)}`],
		usedBy: [
			['human-flare-auth', 'API_KEY'],
			['human-flare-api', 'WORKOS_API_KEY'],
		],
	},
	{
		keys: ['HUMANLAYER_AUTH_SIGNING_KEY_JWK'],
		make: async () => [await signingJwk()],
		usedBy: [['human-flare-auth', 'SIGNING_KEY_JWK']],
	},
	{
		keys: ['HUMANLAYER_AUTH_WEBHOOK_SECRET'],
		make: () => [base64url(32)],
		usedBy: [
			['human-flare-auth', 'WEBHOOK_SECRET'],
			['human-flare-api', 'WORKOS_WEBHOOK_SECRET'],
		],
	},
]

async function ensureSecrets(dryRun: boolean) {
	step(`Ensuring generated secrets${dryRun ? ' (dry run: nothing is written)' : ''}`)
	for (const secret of GENERATED_SECRETS) {
		const label = secret.keys.join(' + ')
		const missing = secret.keys.filter((key) => !env[key])
		if (missing.length === 0) {
			log(`    ${label}: in .env.cloudflare`)
			continue
		}
		// Never replace a value that is already live: if any Worker has one of these secrets set,
		// keep it (it is inherited on deploy) instead of generating a different one.
		const live: string[] = []
		for (const [worker, name] of secret.usedBy) {
			if ((await remoteSecretNames(worker)).has(name)) live.push(`${worker}:${name}`)
		}
		if (live.length > 0) {
			warn(`    ${label}: not in .env.cloudflare, but set on ${live.join(', ')}; kept as is (not regenerated)`)
			continue
		}
		if (missing.length !== secret.keys.length) {
			throw new DeployError(`${label}: only some of these keys are in .env.cloudflare; set all or none`)
		}
		if (dryRun) {
			log(`    ${label}: would be generated`)
			continue
		}
		const values = await secret.make()
		secret.keys.forEach((key, index) => {
			const value = values[index] as string
			addSecretValue(value)
			appendEnv(key, value, dryRun)
		})
		log(`    ${label}: generated and appended to .env.cloudflare`)
	}
}

/** The value a Worker secret gets, from .env.cloudflare and the derived auth settings. */
function secretValue(target: Target, name: string): string | undefined {
	if (target.name === 'auth') {
		const source: Record<string, string> = {
			API_KEY: 'HUMANLAYER_AUTH_API_KEY',
			SIGNING_KEY_JWK: 'HUMANLAYER_AUTH_SIGNING_KEY_JWK',
			SIGNING_KEY_JWK_PREVIOUS: 'HUMANLAYER_AUTH_SIGNING_KEY_JWK_PREVIOUS',
			WEBHOOK_SECRET: 'HUMANLAYER_AUTH_WEBHOOK_SECRET',
		}
		return env[source[name] ?? name] || undefined
	}
	if (target.name === 'api') {
		const auth = resolveAuth(env)
		const derived: Record<string, string> = {
			WORKOS_API_KEY: auth.apiKey,
			WORKOS_CLIENT_ID: auth.clientId,
			WORKOS_API_HOSTNAME: auth.apiHostname,
			WORKOS_REDIRECT_URI: auth.redirectUri,
			WORKOS_WEBHOOK_SECRET: auth.webhookSecret,
		}
		if (name in derived) return derived[name] || undefined
	}
	return env[name] || undefined
}

// ---------------------------------------------------------------------------------------------
// Migrations

async function runMigrations(selected: Target[], dryRun: boolean) {
	step('Running Postgres migrations (packages/db, drizzle-kit migrate)')
	await run(['bun', '--bun', 'drizzle-kit', 'migrate'], {
		cwd: join(ROOT, 'packages/db'),
		env: childEnv({ DATABASE_URL: env.DATABASE_URL }),
	})
	const auth = selected.find((target) => target.name === 'auth')
	if (!auth) return
	step('Running D1 migrations (apps/cf-auth/migrations)')
	const { path } = render(auth, dryRun)
	await run([WRANGLER, 'd1', 'migrations', 'apply', RESOURCES.d1, '--remote', '--config', path], {
		cwd: join(ROOT, auth.dir),
		// CI=1: apply without the interactive confirmation.
		env: childEnv({ CI: '1' }),
	})
}

// ---------------------------------------------------------------------------------------------
// Sites

function deleteSourceMaps(dir: string) {
	if (!existsSync(dir)) return
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) deleteSourceMaps(path)
		else if (entry.endsWith('.map')) unlinkSync(path)
	}
}

/** Build env for a site: the parent env with every VITE_PUBLIC_* / SENTRY_* var cleared first. */
function siteBuildEnv(vars: Record<string, string>): Record<string, string | undefined> {
	const base = childEnv()
	for (const key of Object.keys(base)) {
		if (key.startsWith('VITE_') || key.startsWith('SENTRY_')) delete base[key]
	}
	return { ...base, NODE_OPTIONS: '--max-old-space-size=8192', ...vars }
}

async function gitSha(): Promise<string> {
	const result = await run(['git', 'rev-parse', 'HEAD'], { quiet: true, allowFailure: true })
	return result.code === 0 ? result.output.trim() : 'cloudflare'
}

async function buildSite(target: Target, skipBuild: boolean) {
	const o = resolveOrigins(env)
	const auth = resolveAuth(env, o)
	const dir = join(ROOT, target.dir)
	const outDir = target.site === 'docs' ? join(dir, '.vitepress/dist') : join(dir, 'dist')
	if (skipBuild) {
		if (!existsSync(join(outDir, 'index.html'))) throw new DeployError(`--skip-build but ${outDir} has no build`)
		log(`    reusing existing build in ${outDir}`)
	} else {
		const common = {
			VITE_PUBLIC_RIPTIDE_API_ORIGIN: o.api,
			VITE_PUBLIC_SYNC_ORIGIN: o.sync,
			VITE_PUBLIC_APP_ORIGIN: o.app,
			VITE_PUBLIC_BILLING_ENFORCEMENT_ENABLED: templateVars(env).IS_BILLING_ENFORCEMENT_ENABLED as string,
			VITE_PUBLIC_ENVIRONMENT: 'prod',
			VITE_PUBLIC_BUILD_VERSION: await gitSha(),
		}
		const authVars: Record<string, string> = {
			VITE_PUBLIC_WORKOS_CLIENT_ID: auth.clientId,
			VITE_PUBLIC_WORKOS_API_HOSTNAME: auth.apiHostname,
			...(auth.apiHttps ? { VITE_PUBLIC_WORKOS_API_HTTPS: auth.apiHttps } : {}),
			...(auth.apiPort ? { VITE_PUBLIC_WORKOS_API_PORT: auth.apiPort } : {}),
		}
		// Optional browser analytics / error reporting, passed through when set.
		const optional: Record<string, string> = {}
		for (const key of ['VITE_PUBLIC_POSTHOG_KEY', 'VITE_PUBLIC_POSTHOG_HOST', 'VITE_PUBLIC_SENTRY_DSN']) {
			if (env[key]) optional[key] = env[key] as string
		}
		let vars: Record<string, string> = {}
		if (target.site === 'app') {
			vars = {
				...common,
				...authVars,
				...optional,
				VITE_PUBLIC_CLOUD_ORIGIN: o.cloud,
				VITE_PUBLIC_BUILD_TYPE: 'prod',
				VITE_PUBLIC_REMOTE_DAEMON_BUILD_TYPE: 'prod',
				VITE_PUBLIC_DEEP_LINK_SCHEME: 'humanlayer',
			}
		} else if (target.site === 'cloud') {
			vars = { ...common, ...authVars, ...optional, VITE_PUBLIC_BLOCK_NEW_ORG_CREATION: 'false' }
		}
		log(`    building ${target.dir} with ${Object.keys(vars).length} VITE_PUBLIC_* values`)
		for (const [key, value] of Object.entries(vars)) log(`      ${key}=${value}`)
		await run(['bun', 'run', 'build'], { cwd: dir, env: siteBuildEnv(vars) })
		// Without Sentry nothing consumes source maps; do not publish them.
		deleteSourceMaps(outDir)
	}
	const headers =
		target.site === 'docs'
			? docsHeadersFile()
			: spaHeadersFile({
					apiOrigin: o.api,
					syncOrigin: o.sync,
					// riptide-ui fetches package metadata from npm (reference: additionalConnectSrc).
					additionalConnectSrc: [auth.apiOrigin, ...(target.site === 'app' ? ['https://registry.npmjs.org'] : [])],
				})
	writeFileSync(join(outDir, '_headers'), headers)
	log(`    wrote ${join(target.dir, target.site === 'docs' ? '.vitepress/dist' : 'dist', '_headers')}`)
}

// ---------------------------------------------------------------------------------------------
// Workers

function render(target: Target, dryRun: boolean): { path: string; config: WranglerConfig } {
	const vars = templateVars(env)
	if (dryRun) for (const [key, id] of Object.entries(DRY_RUN_IDS)) vars[key] ??= id
	return renderWranglerConfig(join(ROOT, target.dir), vars, env.CLOUDFLARE_ACCOUNT_ID)
}

async function deployTarget(target: Target, dryRun: boolean) {
	const cwd = join(ROOT, target.dir)
	const { path, config } = render(target, dryRun)
	if (config.name !== target.worker) {
		throw new DeployError(`${target.dir}/wrangler.jsonc names "${config.name}", expected "${target.worker}"`)
	}
	const args = [WRANGLER, 'deploy', '--config', path]
	if (dryRun) args.push('--dry-run')
	let tempDir: string | undefined
	try {
		if (!target.site) {
			if (!config.secrets) {
				throw new DeployError(`${target.dir}/wrangler.jsonc has no "secrets" block; declare secrets.required`)
			}
			const required = config.secrets.required ?? []
			const values: Record<string, string> = {}
			const missing: string[] = []
			for (const name of required) {
				const value = secretValue(target, name)
				if (value) values[name] = value
				else missing.push(name)
			}
			for (const name of target.optionalSecrets ?? []) {
				const value = secretValue(target, name)
				if (value) values[name] = value
			}
			if (missing.length > 0) {
				const remote = await remoteSecretNames(target.worker)
				const absent = missing.filter((name) => !remote.has(name))
				if (absent.length > 0) {
					throw new DeployError(
						`${target.worker}: secrets ${absent.join(', ')} are neither in .env.cloudflare nor set on the Worker`,
					)
				}
				warn(`    ${missing.join(', ')}: not in .env.cloudflare; keeping the values set on ${target.worker}`)
			}
			const names = Object.keys(values)
			if (names.length > 0 && !dryRun) {
				tempDir = mkdtempSync(join(tmpdir(), 'hl-cf-secrets-'))
				const file = join(tempDir, 'secrets.json')
				writeFileSync(file, JSON.stringify(values), { mode: 0o600 })
				args.push('--secrets-file', file)
			}
			log(
				`    secrets: ${names.length > 0 ? names.join(', ') : 'none'}${dryRun && names.length > 0 ? ' (not uploaded in a dry run)' : ''}`,
			)
		}
		await run(args, { cwd })
	} finally {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true })
	}
}

async function publishCli() {
	step('CLI for cloud hosts (apps/cf-hosts/scripts/build-cli.ts --upload --if-changed)')
	const targets = env.CLI_TARGETS?.trim() || 'linux-x64,linux-arm64,darwin-arm64,darwin-x64'
	const targetArgs = targets === 'all' ? ['--all'] : ['--targets', targets]
	await run(['bun', 'run', 'scripts/build-cli.ts', '--upload', '--if-changed', ...targetArgs], {
		cwd: join(ROOT, 'apps/cf-hosts'),
	})
}

async function authUserCount(): Promise<number | undefined> {
	const auth = TARGETS.find((target) => target.name === 'auth') as Target
	const { path } = render(auth, false)
	const result = await run(
		[WRANGLER, 'd1', 'execute', RESOURCES.d1, '--remote', '--json', '--config', path, '--command', 'SELECT count(*) AS n FROM users'],
		{ cwd: join(ROOT, auth.dir), quiet: true, allowFailure: true },
	)
	if (result.code !== 0) return undefined
	try {
		const parsed = JSON.parse(result.output.slice(result.output.indexOf('['))) as { results: { n: number }[] }[]
		return parsed[0]?.results[0]?.n
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------------------------
// Main

function listTargets() {
	const fileEnv = readEnvFile()
	for (const target of TARGETS) {
		console.log(`${target.name.padEnd(9)} ${target.worker.padEnd(20)} ${target.dir}`)
	}
	if (!fileEnv) {
		console.log('\n.env.cloudflare not found: copy .env.cloudflare.example and fill it in (see CLOUDFLARE.md)')
		return
	}
	try {
		console.log('')
		for (const [name, origin] of Object.entries(resolveOrigins(fileEnv))) console.log(`${name.padEnd(9)} ${origin}`)
	} catch (error) {
		console.log(error instanceof Error ? error.message : String(error))
	}
	console.log('')
	for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'HYPERDRIVE_ID', 'BILLING_KV_ID', 'AUTH_D1_DATABASE_ID']) {
		console.log(`${key.padEnd(22)} ${fileEnv[key] ?? '(not set: the deploy finds it by name or creates it)'}`)
	}
}

async function main() {
	const flags = parseArgs(process.argv.slice(2))
	if (flags.list) return listTargets()

	env = requireEnvFile()
	for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'DATABASE_URL']) {
		if (!env[key]) throw new DeployError(`${key} is missing from .env.cloudflare`)
	}
	resolveOrigins(env) // fails early without WORKERS_SUBDOMAIN
	secretValues = []
	for (const [key, value] of Object.entries(env)) if (!isPublicKey(key)) addSecretValue(value)

	const selected = TARGETS.filter((target) => !flags.only || flags.only.includes(target.name))

	await checkPrerequisites(selected)
	await checkPostgres()
	await ensureResources(flags.dryRun)
	await ensureSecrets(flags.dryRun)

	if (flags.skipMigrations || flags.dryRun) log('\n(skipping migrations)')
	else await runMigrations(selected, flags.dryRun)

	step('Rendering wrangler configs')
	for (const target of selected) log(`    ${target.dir}/wrangler.rendered.json`)
	for (const target of selected) render(target, flags.dryRun)

	if (selected.some((target) => target.name === 'hosts') && !flags.dryRun && !flags.skipCli) await publishCli()

	const results: { target: Target; status: 'deployed' | 'validated' | 'failed'; note?: string }[] = []
	for (const target of selected) {
		step(`${target.worker} (${target.dir})`)
		try {
			if (target.site) await buildSite(target, flags.skipBuild)
			await deployTarget(target, flags.dryRun)
			results.push({ target, status: flags.dryRun ? 'validated' : 'deployed' })
		} catch (error) {
			results.push({ target, status: 'failed', note: error instanceof Error ? error.message : String(error) })
			// Later targets depend on earlier ones: stop at the first failure.
			break
		}
	}

	step('Summary')
	for (const { target, status, note } of results) {
		log(`    ${status.padEnd(9)} ${target.worker}${note ? `  (${note})` : ''}`)
	}
	if (envWrites.length > 0) log(`    appended to .env.cloudflare: ${envWrites.join(', ')}`)
	if (results.some((result) => result.status === 'failed')) {
		process.exitCode = 1
		return
	}
	if (flags.dryRun) return

	const o = resolveOrigins(env)
	step('URLs')
	log(`    app        ${o.app}`)
	log(`    cloud      ${o.cloud}`)
	log(`    docs       ${o.docs}`)
	log(`    api        ${o.api}`)
	log(`    sync       ${o.sync}`)
	log(`    auth       ${o.auth}`)
	log(`    hosts      ${o.hosts}`)
	log(`    CLI        ${o.hosts}/cli/latest/humanlayer-<linux-x64|linux-arm64|darwin-arm64|darwin-x64>`)
	const users = await authUserCount()
	step('Remaining manual step')
	if (users === undefined || users === 0) {
		log('    Create the first user (sign-up is closed until someone can invite):')
		log('      cd apps/cf-auth && bun run bootstrap -- --email you@example.com --first-name You')
		log('    The password is written to apps/cf-auth/.bootstrap-credentials.json (0600).')
		log(`    Then sign in at ${o.cloud} and create your organization.`)
	} else {
		log(`    none: the auth service already has ${users} user(s).`)
		log('    To add one: cd apps/cf-auth && bun run bootstrap -- --email someone@example.com')
	}
}

main()
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		const prefix = error instanceof DeployError || error instanceof ConfigError ? '' : 'unexpected error: '
		console.error(redact(`\n\x1b[31mdeploy failed: ${prefix}${message}\x1b[0m`))
		process.exitCode = 1
	})
	.finally(() => rmSync(RESOURCE_CWD, { recursive: true, force: true }))
