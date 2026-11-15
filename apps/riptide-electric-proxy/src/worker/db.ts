/**
 * Per-request Postgres access for the Cloudflare Worker build.
 *
 * workerd forbids using a socket opened by one request from another request, so the Node pattern
 * (lib/db.ts: one module-level postgres.js pool) cannot work. Hyperdrive does the pooling instead:
 * every request opens its own short-lived postgres.js client against
 * `env.HYPERDRIVE.connectionString`, and closes it from `ctx.waitUntil` once the response is ready.
 *
 * The routes receive `config.db` once, when the Hono app is built, so `requestScopedDb` is a stable
 * proxy that resolves to the current request's drizzle instance through AsyncLocalStorage. The
 * client is created lazily: requests that never hit an ACL check never open a connection.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { DbClient } from '@/lib/queries'

/** Hyperdrive caps simultaneous connections per Worker invocation at 6; stay below that. */
const MAX_CONNECTIONS_PER_REQUEST = 5

export class RequestDbScope {
	private sql: postgres.Sql | undefined
	private client: DbClient | undefined

	constructor(private readonly connectionString: string) {}

	get db(): DbClient {
		if (!this.client) {
			this.sql = postgres(this.connectionString, {
				max: MAX_CONNECTIONS_PER_REQUEST,
				// Hyperdrive pools in transaction mode and supports prepared statements.
				prepare: true,
				// Saves a round trip per connection; the proxy only uses built-in types.
				fetch_types: false,
				connect_timeout: 10,
			})
			this.client = drizzle(this.sql)
		}
		return this.client
	}

	/** Close the client if one was opened. Waits for in-flight queries. */
	async close(): Promise<void> {
		const sql = this.sql
		this.sql = undefined
		this.client = undefined
		if (sql) await sql.end({ timeout: 5 })
	}
}

const storage = new AsyncLocalStorage<RequestDbScope>()

export function runWithRequestDb<T>(scope: RequestDbScope, fn: () => T): T {
	return storage.run(scope, fn)
}

function currentDb(): DbClient {
	const scope = storage.getStore()
	if (!scope) throw new Error('Database used outside of a request scope (runWithRequestDb)')
	return scope.db
}

/** Drizzle-shaped proxy that forwards every access to the current request's client. */
export const requestScopedDb = new Proxy({} as DbClient, {
	get(_target, property) {
		const db = currentDb()
		const value = Reflect.get(db, property, db)
		return typeof value === 'function' ? value.bind(db) : value
	},
	has(_target, property) {
		return Reflect.has(currentDb(), property)
	},
})
