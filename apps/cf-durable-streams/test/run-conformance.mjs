#!/usr/bin/env node
/**
 * Runs the upstream @durable-streams/server-conformance-tests suite against a
 * running server (default: `wrangler dev` on http://127.0.0.1:8787).
 *
 *   node test/run-conformance.mjs [baseUrl] [extra vitest args...]
 *
 * The package's own CLI cannot find its vitest under bun's isolated linker, so
 * this resolves the vitest 4 that the suite depends on and runs it directly.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const suiteDir = dirname(realpathSync(require.resolve('@durable-streams/server-conformance-tests/package.json')))
const suiteRequire = createRequire(join(suiteDir, 'package.json'))
const vitestDir = dirname(realpathSync(suiteRequire.resolve('vitest/package.json')))
const runner = join(suiteDir, 'dist', 'test-runner.js')

const [baseUrl = 'http://127.0.0.1:8787', ...extra] = process.argv.slice(2)

const configDir = join(tmpdir(), 'cf-durable-streams-conformance')
mkdirSync(configDir, { recursive: true })
const configPath = join(configDir, 'vitest.config.mjs')
writeFileSync(
	configPath,
	`export default { test: { root: ${JSON.stringify(suiteDir)}, include: [${JSON.stringify(runner)}] } }\n`,
)

const result = spawnSync(
	process.execPath,
	[join(vitestDir, 'vitest.mjs'), 'run', '--config', configPath, '--no-coverage', ...extra],
	{ stdio: 'inherit', env: { ...process.env, CONFORMANCE_TEST_URL: baseUrl } },
)
process.exit(result.status ?? 1)
