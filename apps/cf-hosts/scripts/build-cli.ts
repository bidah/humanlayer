/**
 * Build this fork's `humanlayer` CLI with the deployment's backend origins and auth service baked in,
 * and optionally publish it to R2 (`human-flare-artifacts/cli/<version>/...` + `cli/latest.json`).
 * human-flare-hosts serves the result at `<HOSTS_ORIGIN>/cli/latest/humanlayer-<platform>`.
 *
 *   bun run scripts/build-cli.ts                                  # linux-x64 -> dist/cli/
 *   bun run scripts/build-cli.ts --targets darwin-arm64           # a binary for this Mac
 *   bun run scripts/build-cli.ts --all --upload                   # every platform, then publish
 *   bun run scripts/build-cli.ts --upload --if-changed            # publish unless latest.json matches
 *
 * Targets: linux-x64 (what cloud hosts install; always included in an upload), linux-arm64,
 * darwin-arm64, darwin-x64, win32-x64. Bun cross-compiles them all from any machine.
 *
 * Values come from the repo's .env.cloudflare (scripts/cloudflare/config.ts): the API, sync, cloud
 * and app origins; WORKOS_API_ORIGIN, the origin `humanlayer login` runs the device flow against
 * (default: the human-flare-auth Worker); and PROD_WORKOS_CLIENT_ID (default: its client id).
 *
 * The CLI bakes configuration through Bun macros that read `process.env` at build time
 * (apps/cli/src/lib/macros, apps/riptide-daemon/src/lib/macros). To guarantee nothing else from
 * the operator's shell (secrets in particular) can leak into the binary, each build re-executes
 * this script under a scrubbed environment that contains only PATH/HOME and the allowlisted build
 * vars below, then scans the produced binary for every value in `.env.cloudflare` before uploading.
 *
 * Mirrors apps/cli/build.ts (same entrypoint, plugin and define) but writes its output inside this
 * package so it never touches apps/cli.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { requireEnvFile, resolveAuth, resolveOrigins } from '../../../scripts/cloudflare/config'

const PKG_DIR = path.resolve(import.meta.dir, '..')
const REPO_ROOT = path.resolve(PKG_DIR, '../..')
const CLI_DIR = path.join(REPO_ROOT, 'apps/cli')
const OUT_DIR = path.join(PKG_DIR, 'dist/cli')
const BUCKET = 'human-flare-artifacts'

const PLATFORMS = {
	'linux-x64': { target: 'bun-linux-x64-baseline', file: 'humanlayer-linux-x64', type: /ELF 64-bit .*x86-64/ },
	'linux-arm64': { target: 'bun-linux-arm64', file: 'humanlayer-linux-arm64', type: /ELF 64-bit .*(aarch64|ARM)/ },
	'darwin-arm64': { target: 'bun-darwin-arm64', file: 'humanlayer-darwin-arm64', type: /Mach-O 64-bit .*arm64/ },
	'darwin-x64': { target: 'bun-darwin-x64-baseline', file: 'humanlayer-darwin-x64', type: /Mach-O 64-bit .*x86_64/ },
	'win32-x64': { target: 'bun-windows-x64-baseline', file: 'humanlayer-win32-x64.exe', type: /PE32\+ executable/ },
} as const
type Platform = keyof typeof PLATFORMS
const isPlatform = (value: string): value is Platform => value in PLATFORMS

const { values } = parseArgs({
	options: {
		upload: { type: 'boolean', default: false },
		'if-changed': { type: 'boolean', default: false },
		targets: { type: 'string' },
		all: { type: 'boolean', default: false },
		inner: { type: 'boolean', default: false },
		target: { type: 'string' },
		outfile: { type: 'string' },
	},
})

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
	const res = spawnSync(cmd, args, {
		cwd: opts.cwd ?? REPO_ROOT,
		env: opts.env ?? process.env,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	})
	if (res.status !== 0) {
		throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout).slice(-2000)}`)
	}
	return res.stdout.trim()
}

function cliVersion(): string {
	return JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8')).version
}

async function innerBuild(target: string, outfile: string) {
	// Runs under the scrubbed environment set up by outer().
	const { embedPhotonWasmPlugin } = await import('../../../scripts/bun-build-plugins/embed-photon-wasm')
	process.chdir(CLI_DIR)
	const result = await Bun.build({
		entrypoints: ['./src/index.ts'],
		compile: { target: target as Bun.Build.CompileTarget, outfile },
		define: { __VERSION__: JSON.stringify(process.env.BUILD_VERSION) },
		plugins: [embedPhotonWasmPlugin],
	})
	if (!result.success) {
		console.error('Build failed:', result.logs)
		process.exit(1)
	}
}

// ---------------------------------------------------------------------------------------------
// Outer: configuration, builds, verification, upload

const env = values.inner ? {} : requireEnvFile()

function bakedConfig() {
	const origins = resolveOrigins(env)
	const auth = resolveAuth(env, origins)
	return {
		origins: { api: origins.api, sync: origins.sync, cloud: origins.cloud, app: origins.app },
		workosApiOrigin: auth.apiOrigin,
		workosClientId: auth.clientId,
	}
}

function selectedPlatforms(): Platform[] {
	const requested = values.all ? Object.keys(PLATFORMS) : (values.targets ?? 'linux-x64').split(',')
	const platforms = requested.map((name) => name.trim()).filter(Boolean)
	for (const name of platforms) {
		if (!isPlatform(name)) throw new Error(`Unknown target ${name}. Known: ${Object.keys(PLATFORMS).join(', ')}`)
	}
	const out = [...new Set(platforms as Platform[])]
	// Cloud hosts install linux-x64 from latest.json, so a published version must carry it.
	if (values.upload && !out.includes('linux-x64')) out.unshift('linux-x64')
	return out
}

/** Values from .env.cloudflare that must never appear in a binary. */
function secretValues(): string[] {
	const out: string[] = []
	// Public identifiers that legitimately appear in URLs or are baked on purpose.
	const publicKeys = new Set([
		'CLOUDFLARE_ACCOUNT_ID',
		'WORKERS_SUBDOMAIN',
		'WORKOS_CLIENT_ID',
		'WORKOS_API_HOSTNAME',
		'WORKOS_REDIRECT_URI',
		'DAYTONA_API_URL',
	])
	for (const [key, value] of Object.entries(env)) {
		if (publicKeys.has(key) || key.endsWith('_ORIGIN') || value.length < 8) continue
		out.push(value)
		// Keys are stored base64-encoded; also look for the decoded PEM body.
		if (key.endsWith('_KEY') && /^[A-Za-z0-9+/=]+$/.test(value)) {
			const decoded = Buffer.from(value, 'base64').toString('utf8')
			const body = decoded.split('\n').find((line) => line.length > 40 && !line.startsWith('-----'))
			if (body) out.push(body)
		}
	}
	return out
}

type Built = { platform: Platform; file: string; outfile: string; sha256: string; size: number; fileType: string }

function verifyBinary(platform: Platform, outfile: string, baked: ReturnType<typeof bakedConfig>): Built {
	const spec = PLATFORMS[platform]
	const fileType = run('file', ['-b', outfile])
	if (!spec.type.test(fileType)) throw new Error(`${platform}: unexpected binary type: ${fileType}`)
	const buf = readFileSync(outfile)
	const leaked = secretValues().filter((value) => buf.includes(Buffer.from(value)))
	if (leaked.length > 0) {
		throw new Error(`Refusing to continue: ${leaked.length} value(s) from .env.cloudflare found inside ${outfile}`)
	}
	for (const value of [...Object.values(baked.origins), baked.workosApiOrigin, baked.workosClientId]) {
		if (!buf.includes(Buffer.from(value))) throw new Error(`${platform}: baked value missing from binary: ${value}`)
	}
	const sha256 = createHash('sha256').update(buf).digest('hex')
	return { platform, file: spec.file, outfile, sha256, size: statSync(outfile).size, fileType }
}

/**
 * Identifies the inputs of a build: commit, uncommitted changes, baked config and targets. An
 * upload with `--if-changed` is skipped when cli/latest.json already carries the same value.
 */
function buildFingerprint(platforms: Platform[], baked: ReturnType<typeof bakedConfig>): string {
	// Source paths that can end up in the binary (documentation excluded).
	const sources = [
		'apps',
		'packages',
		'contracts',
		'vendor',
		'scripts/bun-build-plugins',
		'package.json',
		'bun.lock',
		':(exclude,glob)**/*.md',
	]
	const hash = createHash('sha256')
	hash.update(run('git', ['rev-parse', 'HEAD']))
	hash.update(run('git', ['diff', 'HEAD', '--', ...sources]))
	const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '--', ...sources])
	if (untracked) hash.update(run('git', ['hash-object', ...untracked.split('\n')]))
	hash.update(JSON.stringify({ baked, platforms: [...platforms].sort(), cliVersion: cliVersion() }))
	return hash.digest('hex')
}

/** Version key for R2: short git sha, plus `-dirty.<utc timestamp>` when the tree has local changes. */
function artifactVersion(): { version: string; gitSha: string; dirty: boolean } {
	const gitSha = run('git', ['rev-parse', '--short=12', 'HEAD'])
	const dirty = run('git', ['status', '--porcelain']).length > 0
	const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
	return { version: dirty ? `${gitSha}-dirty.${stamp}` : gitSha, gitSha, dirty }
}

function wrangler(args: string[]) {
	const bin = path.join(REPO_ROOT, 'node_modules/.bin/wrangler')
	return run(bin, args, {
		// No wrangler config here: R2 object commands only need the account.
		cwd: tmpdir(),
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false' },
	})
}

function publishedFingerprint(): string | undefined {
	const dir = mkdtempSync(path.join(tmpdir(), 'hl-cli-latest-'))
	try {
		const file = path.join(dir, 'latest.json')
		wrangler(['r2', 'object', 'get', `${BUCKET}/cli/latest.json`, '--remote', '--file', file])
		return (JSON.parse(readFileSync(file, 'utf8')) as { buildFingerprint?: string }).buildFingerprint
	} catch {
		return undefined
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

function put(key: string, file: string, contentType: string) {
	const args = ['r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--file', file, '--content-type', contentType]
	// A 100 MB upload can outlive wrangler's OAuth access token (401 mid-upload); a new wrangler
	// process refreshes the token, so retry a failed upload a few times.
	for (let attempt = 1; ; attempt++) {
		try {
			wrangler(args)
			return
		} catch (error) {
			if (attempt >= 3) throw error
			console.error(`Upload of ${key} failed (attempt ${attempt}); retrying`)
		}
	}
}

function upload(built: Built[], baked: ReturnType<typeof bakedConfig>, fingerprint: string) {
	const { version, gitSha, dirty } = artifactVersion()
	const files: Record<string, { key: string; sha256: string; size: number }> = {}
	for (const item of built) {
		const key = `cli/${version}/${item.file}`
		console.error(`Uploading ${key} (${(item.size / 1024 / 1024).toFixed(1)} MiB)...`)
		put(key, item.outfile, 'application/octet-stream')
		files[item.file] = { key, sha256: item.sha256, size: item.size }
	}
	const linux = files['humanlayer-linux-x64']
	if (!linux) throw new Error('linux-x64 was not built')
	const manifest = {
		version,
		gitSha,
		dirty,
		cliVersion: cliVersion(),
		platform: 'linux-x64',
		key: linux.key,
		sha256: linux.sha256,
		size: linux.size,
		files,
		origins: { ...baked.origins, workos: baked.workosApiOrigin },
		workosClientId: baked.workosClientId,
		buildFingerprint: fingerprint,
		builtAt: new Date().toISOString(),
	}
	const manifestPath = path.join(OUT_DIR, 'manifest.json')
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
	put(`cli/${version}/manifest.json`, manifestPath, 'application/json')
	// Pointer last, so `latest` never references a half-uploaded version.
	put('cli/latest.json', manifestPath, 'application/json')
	console.log(JSON.stringify(manifest, null, 2))
}

async function outer() {
	const baked = bakedConfig()
	const platforms = selectedPlatforms()
	const fingerprint = buildFingerprint(platforms, baked)
	if (values.upload && values['if-changed'] && publishedFingerprint() === fingerprint) {
		console.error('cli/latest.json already matches this source tree and configuration; nothing to upload')
		return
	}
	console.error(`Baking api=${baked.origins.api} sync=${baked.origins.sync} cloud=${baked.origins.cloud}`)
	console.error(`       app=${baked.origins.app} workos=${baked.workosApiOrigin} clientId=${baked.workosClientId}`)
	const scrubbedEnv = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: process.env.HOME ?? '/tmp',
		BUILD_TYPE: 'prod',
		NODE_ENV: 'production',
		BUILD_VERSION: cliVersion(),
		PROD_API_ORIGIN: baked.origins.api,
		PROD_SYNC_ORIGIN: baked.origins.sync,
		PROD_CLOUD_ORIGIN: baked.origins.cloud,
		PROD_APP_ORIGIN: baked.origins.app,
		PROD_WORKOS_CLIENT_ID: baked.workosClientId,
		WORKOS_API_ORIGIN: baked.workosApiOrigin,
		RIPTIDE_DAEMON_API_ORIGIN: baked.origins.api,
		RIPTIDE_DAEMON_SYNC_ORIGIN: baked.origins.sync,
		RIPTIDE_DAEMON_CLOUD_ORIGIN: baked.origins.cloud,
		RIPTIDE_DAEMON_APP_ORIGIN: baked.origins.app,
	}
	mkdirSync(OUT_DIR, { recursive: true })
	const built: Built[] = []
	for (const platform of platforms) {
		const spec = PLATFORMS[platform]
		const outfile = path.join(OUT_DIR, spec.file)
		const res = spawnSync(
			process.execPath,
			[import.meta.path, '--inner', '--target', spec.target, '--outfile', outfile],
			{ env: scrubbedEnv, stdio: 'inherit' },
		)
		if (res.status !== 0) process.exit(res.status ?? 1)
		const item = verifyBinary(platform, outfile, baked)
		console.error(`Built ${platform} -> ${outfile} (${item.fileType.split(',')[0]}) sha256=${item.sha256}`)
		built.push(item)
	}
	if (values.upload) upload(built, baked, fingerprint)
}

if (values.inner) await innerBuild(values.target ?? '', values.outfile ?? '')
else await outer()
