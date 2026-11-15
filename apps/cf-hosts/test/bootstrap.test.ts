import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
	buildHostEnv,
	logsCommand,
	parseLogsOutput,
	parseStatusOutput,
	renderBootstrapScript,
	renderEnvFile,
	STATUS_COMMAND,
	stateFromStatus,
} from '../src/bootstrap'
import { ANTHROPIC_KEY, HOST_ID, TOKEN } from './helpers'

const params = {
	hostId: HOST_ID,
	provider: 'daytona' as const,
	cliUrl: 'https://humanlayer-hosts.example.workers.dev/cli/abc123/humanlayer-linux-x64',
	cliSha256: 'b'.repeat(64),
	cliVersion: 'abc123',
}

describe('renderBootstrapScript', () => {
	const script = renderBootstrapScript(params)

	it('is valid bash', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'hlhost-'))
		const f = path.join(dir, 'bootstrap.sh')
		writeFileSync(f, script)
		execFileSync('bash', ['-n', f]) // throws on syntax error
	})

	it('pins the CLI URL and checksum, sets the required daemon env, and runs a supervisor', () => {
		expect(script).toContain(`HL_CLI_URL='${params.cliUrl}'`)
		expect(script).toContain(`HL_CLI_SHA256=${params.cliSha256}`)
		expect(script).toContain('HUMANLAYER_DISABLE_SELF_UPDATE=1')
		expect(script).toContain('IS_SANDBOX=1')
		expect(script).toContain('/usr/local/bin/humanlayer daemon launch')
		expect(script).toContain('https://claude.ai/install.sh')
		expect(script).toContain('useradd')
		expect(script).toContain('while true; do')
		expect(script).not.toMatch(/set -x|set -o xtrace/)
	})

	it('contains no secrets (they travel only in host.env)', () => {
		expect(script).not.toContain(TOKEN)
		expect(script).not.toContain('RIPTIDE_DAEMON_TOKEN=')
	})

	it('rejects unsafe interpolations', () => {
		expect(() => renderBootstrapScript({ ...params, cliUrl: "https://x.dev/a'; rm -rf /" })).toThrow()
		expect(() => renderBootstrapScript({ ...params, cliUrl: 'http://x.dev/a' })).toThrow()
		expect(() => renderBootstrapScript({ ...params, cliUrl: 'https://x.dev/a?token=1' })).toThrow()
		expect(() => renderBootstrapScript({ ...params, cliSha256: 'zz' })).toThrow()
		expect(() => renderBootstrapScript({ ...params, hostId: '$(id)' })).toThrow()
	})

	it('is identical for every provider apart from the provider name', () => {
		const a = renderBootstrapScript({ ...params, provider: 'cloudflare' })
		const b = renderBootstrapScript({ ...params, provider: 'e2b' })
		expect(a.replace('HL_PROVIDER=cloudflare', '')).toBe(b.replace('HL_PROVIDER=e2b', ''))
	})
})

describe('env file', () => {
	it('round-trips hostile values through bash `set -a; . file`', () => {
		const tricky = `it's "quoted" $HOME \`id\` $(id)\nsecond line \\ end`
		const env = buildHostEnv({
			hostId: HOST_ID,
			provider: 'cloudflare',
			daemonToken: TOKEN,
			env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY, TRICKY: tricky },
		})
		expect(env).toMatchObject({
			RIPTIDE_DAEMON_TOKEN: TOKEN,
			HUMANLAYER_HOST_ID: HOST_ID,
			HUMANLAYER_DISABLE_SELF_UPDATE: '1',
		})
		const dir = mkdtempSync(path.join(tmpdir(), 'hlhost-'))
		const f = path.join(dir, 'host.env')
		writeFileSync(f, renderEnvFile(env))
		const out = execFileSync('bash', ['-c', `set -a; . "${f}"; printf '%s' "$TRICKY"`], { encoding: 'utf8' })
		expect(out).toBe(tricky)
		const tok = execFileSync('bash', ['-c', `set -a; . "${f}"; printf '%s' "$RIPTIDE_DAEMON_TOKEN"`], {
			encoding: 'utf8',
		})
		expect(tok).toBe(TOKEN)
	})

	it('rejects invalid keys', () => {
		expect(() => renderEnvFile({ 'bad key': 'x' })).toThrow()
	})
})

describe('status and logs parsing', () => {
	it('parses status output and maps state', () => {
		const s = parseStatusOutput('phase=running\nsupervisor=1\ndaemon=1\nerror=\n')
		expect(s).toEqual({ phase: 'running', supervisorRunning: true, daemonRunning: true, error: null })
		expect(stateFromStatus(s)).toBe('running')
		expect(stateFromStatus({ ...s, daemonRunning: false })).toBe('degraded')
		expect(stateFromStatus(parseStatusOutput('phase=claude\n'))).toBe('bootstrapping')
		const f = parseStatusOutput('phase=failed\nerror=Claude Code install failed \n')
		expect(stateFromStatus(f)).toBe('failed')
		expect(f.error).toBe('Claude Code install failed')
		expect(parseStatusOutput('phase=weird').phase).toBe('none')
	})

	it('status command runs on a machine with no host (no root needed)', () => {
		const out = execFileSync('bash', ['-c', STATUS_COMMAND], { encoding: 'utf8' })
		// (daemon flag not asserted: a developer machine may run a real local daemon)
		expect(parseStatusOutput(out)).toMatchObject({ phase: 'none' })
	})

	it('splits the two log sections', () => {
		const out = execFileSync('bash', ['-c', logsCommand(5)], { encoding: 'utf8' })
		expect(parseLogsOutput(out)).toEqual({ bootstrap: '', daemon: '' })
		expect(parseLogsOutput('=====HLHOST:bootstrap=====\nb1\n=====HLHOST:daemon=====\nd1\n')).toEqual({
			bootstrap: 'b1\n',
			daemon: 'd1\n',
		})
	})
})
