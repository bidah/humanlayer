/**
 * Starts the Worker under `wrangler dev` (local workerd, no Docker) with short
 * live-mode timeouts and hands its base URL to the tests.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { TestProject } from 'vitest/node'

declare module 'vitest' {
	export interface ProvidedContext {
		baseUrl: string
	}
}

export const SSE_MAX_DURATION_MS = 2_000
/** Lowered from the 100 MiB default so the per-stream cap is cheap to exercise. */
export const MAX_STREAM_BYTES = 32 * 1024 * 1024

function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			server.close(() => (address && typeof address === 'object' ? resolvePort(address.port) : reject()))
		})
	})
}

let child: ChildProcess | undefined
let stateDir: string | undefined

export async function setup(project: TestProject) {
	const packageDir = resolve(import.meta.dirname, '..')
	const port = await freePort()
	stateDir = mkdtempSync(join(tmpdir(), 'cf-durable-streams-test-'))
	const wrangler = join(packageDir, 'node_modules', '.bin', 'wrangler')
	child = spawn(
		wrangler,
		[
			'dev',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port),
			'--inspector-port',
			String(await freePort()),
			'--persist-to',
			stateDir,
			'--var',
			'LONG_POLL_TIMEOUT_MS:2000',
			'--var',
			`SSE_MAX_DURATION_MS:${SSE_MAX_DURATION_MS}`,
			'--var',
			'SSE_KEEPALIVE_MS:1000',
			'--var',
			`MAX_STREAM_BYTES:${MAX_STREAM_BYTES}`,
		],
		{ cwd: packageDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
	)
	let output = ''
	child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
	child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))

	const baseUrl = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 60_000
	for (;;) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output}`)
		try {
			const res = await fetch(`${baseUrl}/healthz`)
			if (res.ok) break
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) throw new Error(`wrangler dev did not become ready:\n${output}`)
		await new Promise((r) => setTimeout(r, 250))
	}
	project.provide('baseUrl', baseUrl)
}

export async function teardown() {
	if (child && child.exitCode === null) {
		child.kill('SIGTERM')
		await new Promise((r) => setTimeout(r, 500))
		if (child.exitCode === null) child.kill('SIGKILL')
	}
	if (stateDir) rmSync(stateDir, { recursive: true, force: true })
}
