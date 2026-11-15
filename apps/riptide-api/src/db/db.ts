import { instrumentPostgresJsSql } from '@sentry/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { requireEnvironment } from '../lib/environment'
import { isCloudflareWorker } from '../platform/runtime'
import { createWorkerDbs } from './worker-db'

function getPoolConfig() {
	const parseIntEnv = (name: string, defaultValue: number): number => {
		const raw = process.env[name]
		if (!raw) return defaultValue
		const parsed = Number.parseInt(raw, 10)
		if (Number.isNaN(parsed) || parsed < 0) {
			throw new Error(`Invalid ${name}: "${raw}" — must be a non-negative integer`)
		}
		return parsed
	}

	return {
		max: parseIntEnv('DB_POOL_MAX', 10),
		idle_timeout: parseIntEnv('DB_POOL_IDLE_TIMEOUT', 20),
		max_lifetime: parseIntEnv('DB_POOL_MAX_LIFETIME', 300),
		connect_timeout: parseIntEnv('DB_POOL_CONNECT_TIMEOUT', 10),
	}
}

function createNodeDbs() {
	const poolConfig = getPoolConfig()

	const databaseUrl = requireEnvironment('DATABASE_URL')
	const rawClient = postgres(databaseUrl, poolConfig)
	const client = instrumentPostgresJsSql(rawClient, { requireParentSpan: false })
	const db = drizzle(client)

	// Read replica for metrics queries - REQUIRED in all environments (no fallback)
	// For local dev, set READ_REPLICA_DATABASE_URL to same value as DATABASE_URL in .env
	const readReplicaUrl = requireEnvironment('READ_REPLICA_DATABASE_URL')
	const rawReadReplicaClient = postgres(readReplicaUrl, poolConfig)
	const readReplicaClient = instrumentPostgresJsSql(rawReadReplicaClient, { requireParentSpan: false })
	const dbReadReplica = drizzle(readReplicaClient)
	return { db, dbReadReplica }
}

// On Cloudflare Workers the clients are request-local over Hyperdrive (see ./worker-db); on Node
// they are the process-wide pools created here at import, exactly as before.
const dbs: ReturnType<typeof createNodeDbs> = isCloudflareWorker() ? createWorkerDbs() : createNodeDbs()

export const db = dbs.db
export const dbReadReplica = dbs.dbReadReplica
