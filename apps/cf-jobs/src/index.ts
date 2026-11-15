/**
 * humanlayer-jobs: Cron Triggers replacing two AWS Lambdas.
 *
 * - every minute: stale-daemon sweeper (apps/stale-daemon-sweeper, four passes), then the cloud
 *   host reconcile pass (src/cloud-hosts-reconcile.ts; needs the HOSTS binding and
 *   INTERNAL_SERVICE_SECRET, and is skipped without them)
 * - daily: database maintenance (apps/database-maintenance-function, snapshot retention)
 *
 * The logic lives in those packages; this Worker only supplies a Hyperdrive-backed connection.
 * Hyperdrive pools in transaction mode, so session settings (postgres.js `connection: {...}`
 * startup parameters, plain `SET`) do not stick to the backend a query lands on. Timeouts are
 * applied with `SET LOCAL` at the start of every transaction instead; every sweeper and
 * maintenance statement runs inside `db.transaction`.
 */
import { cleanupExpiredCodelayerForkSnapshots } from '@humanlayer/database-maintenance-function/cleanup'
import { runSweepPasses, type DatabaseConnection } from '@humanlayer/stale-daemon-sweeper/sweep'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { makeBindingProvisionerClient, makeDrizzleCloudHostStore, reconcileCloudHosts } from './cloud-hosts-reconcile'

const SWEEPER_CRON = '* * * * *'
const MAINTENANCE_CRON = '17 4 * * *'

/** Same values the Lambda set as connection parameters (apps/stale-daemon-sweeper/index.ts). */
const SWEEPER_TIMEOUTS = { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 }
/**
 * The maintenance Lambda ran with a 120 s timeout and budgets itself with
 * `context.getRemainingTimeInMillis()`; a cron Worker has no such context, so give it the same
 * budget measured from the start of the run. (Its batches already `SET LOCAL` their own timeouts.)
 */
const MAINTENANCE_BUDGET_MS = 120_000

interface Env {
	HYPERDRIVE: Hyperdrive
	/** The cloud host provisioner (`humanlayer-hosts`). */
	HOSTS?: Fetcher
	INTERNAL_SERVICE_SECRET?: string
}

/** Same statement budget as the sweeper; the reconcile pass's own writes are small. */
const RECONCILE_TIMEOUTS = { statementTimeoutMs: 10_000, lockTimeoutMs: 1_000 }

type Timeouts = { statementTimeoutMs: number; lockTimeoutMs: number }
type Db = DatabaseConnection['db']

/** Wraps `db.transaction` so each transaction starts with `SET LOCAL` timeouts. */
function withLocalTimeouts(db: Db, timeouts: Timeouts): Db {
	const statementTimeout = Math.trunc(timeouts.statementTimeoutMs)
	const lockTimeout = Math.trunc(timeouts.lockTimeoutMs)
	const transaction: Db['transaction'] = (run, config) =>
		db.transaction(async (tx) => {
			await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${statementTimeout}`))
			await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${lockTimeout}`))
			return run(tx)
		}, config)
	return new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'transaction') return transaction
			return Reflect.get(target, property, receiver)
		},
	})
}

function connect(env: Env, timeouts?: Timeouts): DatabaseConnection {
	// A Worker may not reuse I/O objects across invocations: build the client per run.
	const client = postgres(env.HYPERDRIVE.connectionString, {
		max: 1,
		connect_timeout: 5,
		// Hyperdrive already knows the types; skip the extra round trip on connect.
		fetch_types: false,
	})
	const db = drizzle(client)
	return {
		db: timeouts ? withLocalTimeouts(db, timeouts) : db,
		close: () => client.end({ timeout: 5 }),
	}
}

async function runSweeper(env: Env) {
	return runSweepPasses({
		loadDatabaseUrl: async () => env.HYPERDRIVE.connectionString,
		createDatabaseConnection: async () => connect(env, SWEEPER_TIMEOUTS),
		captureException: (error) => console.error({ event: 'stale_daemon_sweep_failed', error: String(error) }),
		logSummary: (result) =>
			console.log(
				JSON.stringify({ event: 'session_reconciliation_completed', ...result }, (_key, value) =>
					typeof value === 'bigint' ? value.toString() : value,
				),
			),
	})
}

async function runCloudHostReconcile(env: Env) {
	const provisioner = makeBindingProvisionerClient(env)
	if (!provisioner) return
	const connection = connect(env, RECONCILE_TIMEOUTS)
	try {
		const result = await reconcileCloudHosts(makeDrizzleCloudHostStore(connection.db), provisioner)
		if (result.examined > 0) console.log(JSON.stringify({ event: 'cloud_host_reconcile_completed', ...result }))
	} catch (error) {
		console.error({ event: 'cloud_host_reconcile_failed', error: String(error) })
	} finally {
		await connection.close()
	}
}

async function runMaintenance(env: Env) {
	const deadline = Date.now() + MAINTENANCE_BUDGET_MS
	const connection = connect(env)
	try {
		const result = await cleanupExpiredCodelayerForkSnapshots(connection.db, {
			getRemainingTimeInMillis: () => deadline - Date.now(),
		})
		console.log({ event: 'database_maintenance_completed', ...result })
		return result
	} finally {
		await connection.close()
	}
}

export default {
	async scheduled(controller, env) {
		switch (controller.cron) {
			case SWEEPER_CRON:
				// Independent passes: a sweeper failure must not stop the reconcile pass, or vice versa.
				// runCloudHostReconcile never rejects; a sweeper failure still fails the invocation.
				const [sweep] = await Promise.allSettled([runSweeper(env), runCloudHostReconcile(env)])
				if (sweep.status === 'rejected') throw sweep.reason
				return
			case MAINTENANCE_CRON:
				await runMaintenance(env)
				return
			default:
				throw new Error(`Unknown cron schedule: ${controller.cron}`)
		}
	},
} satisfies ExportedHandler<Env>
