/**
 * Belt-and-braces scrubbing for anything read back from a sandbox (logs, errors) before it leaves
 * this Worker. The bootstrap never prints secrets, but the daemon or an installer might.
 */
const PATTERNS: Array<[RegExp, string]> = [
	// Compact JWTs (daemon tokens, OAuth tokens).
	[/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
	// Anthropic API keys / OAuth tokens.
	[/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_ANTHROPIC]'],
	// OpenAI-style keys.
	[/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]'],
	// GitHub tokens.
	[/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB]'],
	// E2B / Daytona keys.
	[/\be2b_[A-Za-z0-9]{20,}/g, '[REDACTED_E2B]'],
	[/\bdtn_[A-Za-z0-9]{20,}/g, '[REDACTED_DAYTONA]'],
	// Generic "Authorization: Bearer xxx".
	[/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]'],
]

export function redact(text: string, extraSecrets: readonly string[] = []): string {
	let out = text
	for (const s of extraSecrets) {
		if (s && s.length >= 8) out = out.split(s).join('[REDACTED]')
	}
	for (const [re, repl] of PATTERNS) out = out.replace(re, repl)
	return out
}
