import * as Sentry from '@sentry/node'
import 'zod/compile'

Sentry.init({
	// Unset means Sentry stays off, so builds from source report nowhere.
	dsn: process.env.SENTRY_DSN,
	enabled: process.env.SENTRY_DSN !== undefined && (process.env.SENTRY_ENVIRONMENT ?? 'local') !== 'local',
	environment: process.env.SENTRY_ENVIRONMENT ?? 'local',
	tracesSampleRate: 0.0001,
})

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { cleanupExpiredCodelayerForkSnapshots } from './cleanup'

export { cleanupExpiredCodelayerForkSnapshots }
export type { CleanupBatchResult, CleanupOptions, CleanupResult } from './cleanup'

const secretsManager = new SecretsManagerClient({})

async function getDatabaseUrl() {
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

async function createDbClient() {
	console.log('Resolving database URL for database maintenance')
	const databaseUrl = await getDatabaseUrl()
	console.log('Successfully resolved database URL for database maintenance', {
		source: process.env.DATABASE_URL ? 'DATABASE_URL' : 'DATABASE_URL_SECRET_ARN',
		secretArnPresent: Boolean(process.env.DATABASE_URL_SECRET_ARN),
	})
	const client = postgres(databaseUrl, { max: 1 })
	const db = drizzle(client)
	return { client, db }
}

export async function handler(_event: unknown, context?: { getRemainingTimeInMillis?: () => number }) {
	console.log('Starting database maintenance Lambda invocation', {
		sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? 'local',
		initialRemainingTimeMs: context?.getRemainingTimeInMillis?.(),
	})

	let client: postgres.Sql | undefined
	try {
		const created = await createDbClient()
		client = created.client

		const result = await cleanupExpiredCodelayerForkSnapshots(created.db, {
			getRemainingTimeInMillis: context?.getRemainingTimeInMillis,
		})

		console.log('Database maintenance completed successfully', result)
		await Sentry.flush(2000)

		return {
			statusCode: 200,
			body: JSON.stringify(result),
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error'
		console.error('Error running database maintenance:', message)
		console.error(error)
		Sentry.captureException(error, {
			extra: {
				initialRemainingTimeMs: context?.getRemainingTimeInMillis?.(),
				sentryEnvironment: process.env.SENTRY_ENVIRONMENT ?? 'local',
			},
		})
		await Sentry.flush(2000)

		return {
			statusCode: 500,
			body: JSON.stringify({
				success: false,
				message: `Database maintenance failed: ${message}`,
				timestamp: new Date().toISOString(),
			}),
		}
	} finally {
		console.log('Closing database maintenance postgres client')
		await client?.end()
		console.log('Finished database maintenance Lambda invocation')
	}
}

async function main() {
	const { statusCode, body } = await handler({ action: 'cleanup:local' })
	console.log(body)
	process.exitCode = statusCode === 200 ? 0 : 1
}

if (import.meta.main) {
	void main()
}
