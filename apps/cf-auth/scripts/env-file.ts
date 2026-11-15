// Read/append helpers for the repo's gitignored .env.cloudflare. Values are never printed.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ENV_FILE = resolve(import.meta.dirname, '../../../.env.cloudflare')

export function readEnvFile(): Map<string, string> {
	const out = new Map<string, string>()
	if (!existsSync(ENV_FILE)) return out
	for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
		const key = m?.[1]
		if (!key) continue
		let value = (m[2] ?? '').trim()
		if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
			value = value.slice(1, -1)
		out.set(key, value)
	}
	return out
}

/** Appends KEY='value' (append only; existing lines are never rewritten). */
export function appendEnv(key: string, value: string): void {
	if (value.includes("'") || value.includes('\n')) throw new Error(`${key}: value cannot be single-quoted safely`)
	const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
	const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
	appendFileSync(ENV_FILE, `${prefix}${key}='${value}'\n`, { mode: 0o600 })
}
