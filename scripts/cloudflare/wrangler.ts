#!/usr/bin/env bun
/**
 * Runs wrangler for the Worker package in the current directory against its rendered config.
 *
 *   cd apps/cf-jobs && bun ../../scripts/cloudflare/wrangler.ts deploy
 *   (package scripts: `bun run dev`, `bun run deploy`, ...)
 *
 * Renders ./wrangler.jsonc with the values from the repo's .env.cloudflare into
 * ./wrangler.rendered.json (see scripts/cloudflare/config.ts), then runs
 * `wrangler <args> --config wrangler.rendered.json` with CLOUDFLARE_ACCOUNT_ID set. An explicit
 * `-c wrangler.jsonc` / `--config wrangler.jsonc` argument is replaced by the rendered file; other
 * `-c` arguments (extra configs of a multi-Worker `wrangler dev`) are kept.
 *
 * Fails, without running wrangler, when .env.cloudflare is missing or a value is unresolved.
 * Secrets are not uploaded here; `bun run cloudflare:deploy` at the repo root does that.
 */
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { ConfigError, RENDERED_CONFIG_NAME, WRANGLER, renderFromEnvFile } from './config'

function withRenderedConfig(args: string[], rendered: string): string[] {
	const out: string[] = []
	let replaced = false
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		const isFlag = arg === '-c' || arg === '--config'
		const inline = arg.startsWith('--config=') ? arg.slice('--config='.length) : undefined
		const value = isFlag ? args[i + 1] : inline
		if (!replaced && value !== undefined && basename(value) === 'wrangler.jsonc') {
			out.push('--config', rendered)
			replaced = true
			if (isFlag) i++
			continue
		}
		out.push(arg)
	}
	return replaced ? out : [...out, '--config', rendered]
}

async function main() {
	const packageDir = process.cwd()
	if (!existsSync(join(packageDir, 'wrangler.jsonc'))) {
		throw new ConfigError(`no wrangler.jsonc in ${packageDir}; run this from a Worker package directory`)
	}
	const { env } = renderFromEnvFile(packageDir)
	const args = withRenderedConfig(process.argv.slice(2), RENDERED_CONFIG_NAME)
	const proc = Bun.spawn([WRANGLER, ...args], {
		cwd: packageDir,
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID },
		stdio: ['inherit', 'inherit', 'inherit'],
	})
	process.exitCode = await proc.exited
}

main().catch((error: unknown) => {
	console.error(`\x1b[31m${error instanceof ConfigError ? error.message : String(error)}\x1b[0m`)
	process.exitCode = 1
})
