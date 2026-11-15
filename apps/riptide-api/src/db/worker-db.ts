import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { getRequestScope } from '../platform/request-scope'
import { getWorkerEnv } from '../platform/worker-env'

type Db = PostgresJsDatabase<Record<string, never>> & { $client: postgres.Sql }

const RESOURCE_KEY = 'db:hyperdrive'

/**
 * Request-local postgres.js client over Hyperdrive.
 *
 * Cloudflare's guidance is to create database clients inside the handler, never in global scope:
 * a socket opened by one request cannot be used by another. Hyperdrive pools the origin
 * connections, so a fresh client per request is cheap. The client is created on first use in a
 * request and closed after the response and that request's background work have settled.
 *
 * - `prepare: true` (postgres.js default) is supported by Hyperdrive's transaction-mode pooling.
 * - `fetch_types: false` skips the array-type catalogue query on every new connection.
 * - `max: 5` stays under the Workers limit of 6 simultaneous open connections per request.
 */
function getRequestDb(): Db {
	const scope = getRequestScope()
	if (!scope) {
		throw new Error(
			'Database accessed outside a request scope on Cloudflare Workers (module scope or a detached task that lost its request context)',
		)
	}
	const existing = scope.resources.get(RESOURCE_KEY) as Db | undefined
	if (existing) return existing

	const hyperdrive = getWorkerEnv().HYPERDRIVE
	if (!hyperdrive) throw new Error('HYPERDRIVE binding is not configured')
	const client = postgres(hyperdrive.connectionString, {
		max: 5,
		fetch_types: false,
		prepare: true,
		connect_timeout: 10,
		idle_timeout: 0,
	})
	const db = drizzle(client) as Db
	scope.resources.set(RESOURCE_KEY, db)
	scope.cleanups.push(() => client.end({ timeout: 5 }))
	return db
}

/**
 * A drizzle-shaped object whose every property resolves against the current request's client.
 * Existing call sites (`db.select(...)`, `db.transaction(...)`, Effect's `PostgresDbLive(db)`)
 * keep working unchanged; only the backing connection is request-local.
 */
function makeRequestDbProxy(): Db {
	return new Proxy({} as Db, {
		get(_target, property) {
			const target = getRequestDb()
			const value = Reflect.get(target, property, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
		has(_target, property) {
			return Reflect.has(getRequestDb(), property)
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(getRequestDb())
		},
	})
}

export function createWorkerDbs(): { db: Db; dbReadReplica: Db } {
	// Hyperdrive fronts the primary; there is no separate replica on Cloudflare, so reads that
	// targeted the replica go to the same request-local client.
	const db = makeRequestDbProxy()
	return { db, dbReadReplica: db }
}
