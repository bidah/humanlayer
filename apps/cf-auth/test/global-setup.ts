// Starts the Worker under `wrangler dev` (workerd + local D1) with throwaway keys for the test run.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

import type { TestProject } from 'vitest/node'

const PKG = resolve(import.meta.dirname, '..')
const WRANGLER = resolve(PKG, 'node_modules/.bin/wrangler')

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer()
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address()
			srv.close(() => (typeof addr === 'object' && addr ? res(addr.port) : rej(new Error('no port'))))
		})
	})
}

async function generateSigningJwk(): Promise<string> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair
	const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
	return JSON.stringify({ ...jwk, kid: `test_${Date.now()}`, alg: 'RS256' })
}

const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

let proc: ChildProcess | undefined
let webhookServer: Server | undefined
let stateDir: string | undefined

declare module 'vitest' {
	export interface ProvidedContext {
		baseUrl: string
		port: number
		apiKey: string
		clientId: string
		webhookPort: number
		webhookSecret: string
		persistDir: string
	}
}

export default async function setup(project: TestProject) {
	const port = await freePort()
	const webhookPort = await freePort()
	// Captures webhook deliveries (raw body + signature header); tests read them back from /__events.
	const deliveries: Array<{ body: string; signature: string | undefined }> = []
	webhookServer = createHttpServer((req, res) => {
		if (req.method === 'GET' && req.url === '/__events') {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify(deliveries))
			return
		}
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			const sig = req.headers['workos-signature']
			deliveries.push({ body, signature: Array.isArray(sig) ? sig[0] : sig })
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end('{"received":true}')
		})
	})
	await new Promise<void>((r) => webhookServer!.listen(webhookPort, '127.0.0.1', r))
	stateDir = join(PKG, '.test-state', `run-${process.pid}-${Date.now()}`)
	const persistDir = join(stateDir, 'persist')
	mkdirSync(persistDir, { recursive: true })
	const baseUrl = `http://127.0.0.1:${port}`
	const apiKey = `sk_test_${randomSecret()}`
	const webhookSecret = randomSecret()
	const clientId = 'client_humanlayer_cloudflare'
	const envFile = join(stateDir, 'test.env')
	const vars: Record<string, string> = {
		API_KEY: apiKey,
		SIGNING_KEY_JWK: await generateSigningJwk(),
		PUBLIC_URL: baseUrl,
		// wrangler.jsonc is a template (${APP_ORIGIN} etc. are filled in at deploy time); the tests run it
		// unrendered, so every var that holds a placeholder is set here.
		ALLOWED_REDIRECT_URIS: 'http://localhost:3000/* http://localhost:5174/* riptide://oauth/callback',
		INVITATION_LANDING_URL: 'http://localhost:5174/',
		SIGNUP_ALLOWED_EMAILS: '',
		SIGNUP_ALLOWED_DOMAINS: 'allowed.test',
		WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/webhooks/workos`,
		WEBHOOK_SECRET: webhookSecret,
	}
	writeFileSync(
		envFile,
		Object.entries(vars)
			.map(([k, v]) => `${k}='${v}'`)
			.join('\n'),
		{ mode: 0o600 },
	)

	execFileSync(WRANGLER, ['d1', 'migrations', 'apply', 'human-flare-auth', '--local', '--persist-to', persistDir], {
		cwd: PKG,
		stdio: 'pipe',
		env: { ...process.env, CI: '1' },
	})

	proc = spawn(
		WRANGLER,
		[
			'dev',
			'--local',
			'--ip',
			'127.0.0.1',
			'--port',
			String(port),
			'--persist-to',
			persistDir,
			'--env-file',
			envFile,
			'--show-interactive-dev-session=false',
			'--inspector-port',
			String(await freePort()),
		],
		{ cwd: PKG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
	)
	let output = ''
	proc.stdout?.on('data', (d) => (output += d))
	proc.stderr?.on('data', (d) => (output += d))

	const deadline = Date.now() + 60_000
	for (;;) {
		try {
			const res = await fetch(`${baseUrl}/health`)
			if (res.ok) break
		} catch {}
		if (Date.now() > deadline || proc.exitCode !== null)
			throw new Error(`wrangler dev did not start:\n${output.slice(-4000)}`)
		await new Promise((r) => setTimeout(r, 250))
	}

	project.provide('baseUrl', baseUrl)
	project.provide('port', port)
	project.provide('apiKey', apiKey)
	project.provide('clientId', clientId)
	project.provide('webhookPort', webhookPort)
	project.provide('webhookSecret', webhookSecret)
	project.provide('persistDir', persistDir)

	return async () => {
		proc?.kill('SIGTERM')
		webhookServer?.close()
		await new Promise((r) => setTimeout(r, 500))
		if (stateDir) rmSync(stateDir, { recursive: true, force: true })
	}
}
