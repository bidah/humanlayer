/**
 * Core server factory - no side effects, no env vars.
 * Import this for testing or when you want to create an app with custom config.
 */

import { serve } from '@hono/node-server'
import type { Hono } from 'hono'

// Re-export for convenience
export type { AppConfig, SimpleAuthContext } from './app-config'
export { createApp } from './app'
export { type AppRuntime, createTestAppRuntime } from './lib/effect/runtime'

/**
 * Starts the server programmatically. Useful for integration tests.
 * Returns a Bun.serve-compatible subset which can be stopped with server.stop()
 */
export function startServer(app: Hono, port: number = 8888) {
	const server = serve({ fetch: app.fetch, port })
	const address = server.address()
	const assignedPort = typeof address === 'object' && address !== null ? address.port : port

	return {
		port: assignedPort,
		stop: (_force?: boolean) => server.close(),
	}
}
