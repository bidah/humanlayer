// Creates the first user directly in D1 (sign-up is closed by default, so someone has to exist).
//
//   bun scripts/bootstrap.ts --email you@example.com [--first-name Ada] [--last-name Lovelace] [--local]
//
// A random password is generated and hashed here with the Worker's own PBKDF2 parameters. Only the
// hash reaches D1. The email and password are written to apps/cf-auth/.bootstrap-credentials.json
// (gitignored, mode 0600); stdout shows only the new user id and that path.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { readEnvFile, renderFromEnvFile, resolveOrigins } from '../../../scripts/cloudflare/config'
import { hashPassword } from '../src/password'
import { newId } from '../src/util'

const PKG = resolve(import.meta.dirname, '..')
const CREDENTIALS_FILE = join(PKG, '.bootstrap-credentials.json')

const { values } = parseArgs({
	options: {
		email: { type: 'string' },
		'first-name': { type: 'string' },
		'last-name': { type: 'string' },
		local: { type: 'boolean', default: false },
	},
})

const email = values.email?.trim().toLowerCase()
if (!email || !/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)) {
	console.error('usage: bun scripts/bootstrap.ts --email <email> [--first-name X] [--last-name Y] [--local]')
	process.exit(2)
}
const sqlString = (v: string | undefined) => (v ? `'${v.replace(/'/g, "''")}'` : 'NULL')

const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url')
const userId = newId('user')
const now = new Date().toISOString()
const sql = `INSERT INTO users (id, email, email_verified, first_name, last_name, password_hash, metadata, created_at, updated_at) VALUES (${sqlString(userId)}, ${sqlString(email)}, 1, ${sqlString(values['first-name'])}, ${sqlString(values['last-name'])}, ${sqlString(await hashPassword(password))}, '{}', ${sqlString(now)}, ${sqlString(now)});`

// Remote: the rendered config (D1 database id, account) from .env.cloudflare. Local: the template is
// enough when there is no env file (local D1 only needs the database name).
const configArgs: string[] = []
const childEnv: NodeJS.ProcessEnv = { ...process.env, CI: '1' }
let target = 'local'
if (!values.local || readEnvFile()) {
	const rendered = renderFromEnvFile(PKG)
	configArgs.push('--config', rendered.path)
	childEnv.CLOUDFLARE_ACCOUNT_ID = rendered.env.CLOUDFLARE_ACCOUNT_ID
	if (!values.local) target = resolveOrigins(rendered.env).auth
}

const dir = mkdtempSync(join(tmpdir(), 'hl-auth-bootstrap-'))
chmodSync(dir, 0o700)
const sqlFile = join(dir, 'bootstrap.sql')
writeFileSync(sqlFile, sql, { mode: 0o600 })
try {
	const result = spawnSync(
		join(PKG, 'node_modules/.bin/wrangler'),
		[
			'd1',
			'execute',
			'humanlayer-auth',
			values.local ? '--local' : '--remote',
			'--file',
			sqlFile,
			'--yes',
			...configArgs,
		],
		{ cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv },
	)
	if (result.status !== 0) {
		const err = result.stderr.toString() + result.stdout.toString()
		console.error(
			err.includes('UNIQUE')
				? 'A user with that email already exists; nothing was changed.'
				: 'wrangler d1 execute failed.',
		)
		process.exit(1)
	}
} finally {
	rmSync(dir, { recursive: true, force: true })
}

const entry = { label: 'bootstrap user', user_id: userId, email, password, target, created_at: now }
const previous: unknown[] = existsSync(CREDENTIALS_FILE) ? JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) : []
writeFileSync(CREDENTIALS_FILE, `${JSON.stringify([...previous, entry], null, 2)}\n`, { mode: 0o600 })
chmodSync(CREDENTIALS_FILE, 0o600)
console.log(
	`Created ${userId} (${values.local ? 'local' : 'remote'} D1). Credentials written to ${CREDENTIALS_FILE} (mode 0600).`,
)
