/**
 * Runtime detection for the Cloudflare Workers port.
 *
 * workerd sets `navigator.userAgent` to `Cloudflare-Workers`; Node and Bun do not. Code that must
 * behave differently on Workers (per-request database clients, lazy integration clients, no
 * module-scope I/O) branches on this instead of on an env var so the Node/AWS path stays the
 * default and unchanged.
 */
export function isCloudflareWorker(): boolean {
	return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}
