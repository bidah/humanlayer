// Uploads the Worker secrets from .env.cloudflare via `wrangler secret put` (values go over stdin,
// never argv or stdout).
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { renderFromEnvFile } from '../../../scripts/cloudflare/config'
import { readEnvFile } from './env-file'

const env = readEnvFile()
const mapping: Array<[secret: string, source: string, required: boolean]> = [
	['API_KEY', 'HUMANLAYER_AUTH_API_KEY', true],
	['SIGNING_KEY_JWK', 'HUMANLAYER_AUTH_SIGNING_KEY_JWK', true],
	['WEBHOOK_SECRET', 'HUMANLAYER_AUTH_WEBHOOK_SECRET', false],
]
const wrangler = resolve(import.meta.dirname, '../node_modules/.bin/wrangler')
// The rendered config carries the account id (and the D1 id) from .env.cloudflare.
const rendered = renderFromEnvFile(resolve(import.meta.dirname, '..'))

for (const [secret, source, required] of mapping) {
	const value = env.get(source)
	if (!value) {
		if (required) throw new Error(`${source} missing from .env.cloudflare; run \`bun run secrets:generate\` first`)
		continue
	}
	const result = spawnSync(wrangler, ['secret', 'put', secret, '--config', rendered.path], {
		cwd: resolve(import.meta.dirname, '..'),
		input: value,
		stdio: ['pipe', 'ignore', 'pipe'],
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: rendered.env.CLOUDFLARE_ACCOUNT_ID },
	})
	if (result.status !== 0)
		throw new Error(`wrangler secret put ${secret} failed: ${result.stderr.toString().slice(-500)}`)
	console.log(`${secret}: set from ${source}`)
}
