import 'zod/compile'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import * as Sentry from '@sentry/node'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { LostSessionBatchResult, LostSessionLogger } from './lost-sessions'
import { sweepStaleDaemonBatch, type Database, type StaleDaemonBatchResult } from './stale-daemons'
import { runSweepPasses, type DatabaseConnection, type SweepOptions, type SweepResult } from './sweep'

const SENTRY_FLUSH_TIMEOUT_MS = 5_000
const secretsManager = new SecretsManagerClient({})

export type { Database, StaleDaemonBatchResult as BatchResult }
export type { DatabaseConnection, SweepOptions, SweepResult }
export { sweepStaleDaemonBatch }

async function getDatabaseUrl(): Promise<string> {
	if (process.env.DATABASE_URL) {
		return process.env.DATABASE_URL
	}

	const secretArn = process.env.DATABASE_URL_SECRET_ARN
	if (!secretArn) {
		throw new Error('Missing DATABASE_URL or DATABASE_URL_SECRET_ARN environment variable')
	}

	const response = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }))
	if (!response.SecretString) {
		throw new Error('Database URL secret has no string value')
	}

	return response.SecretString
}

export async function createDatabaseConnection(databaseUrl: string): Promise<DatabaseConnection> {
	const client = postgres(databaseUrl, {
		max: 1,
		connect_timeout: 5,
		// The installed Postgres.js types accept milliseconds, not duration strings.
		connection: { statement_timeout: 10_000, lock_timeout: 1_000 },
	})
	return {
		db: drizzle(client),
		close: () => client.end({ timeout: 5 }),
	}
}

export async function runStaleDaemonSweep(options: SweepOptions = {}): Promise<SweepResult> {
	return runSweepPasses({
		...options,
		loadDatabaseUrl: options.loadDatabaseUrl ?? getDatabaseUrl,
		createDatabaseConnection: options.createDatabaseConnection ?? createDatabaseConnection,
		captureException: options.captureException ?? Sentry.captureException,
		flushSentry: options.flushSentry ?? (() => Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)),
	})
}

export async function handler() {
	return runStaleDaemonSweep()
}

if (import.meta.main) {
	void runStaleDaemonSweep()
}

export type { LostSessionBatchResult, LostSessionLogger }
