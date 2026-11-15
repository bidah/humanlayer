// Runtime-neutral sweep orchestration: no Sentry, no AWS SDK, no driver construction.
// index.ts wires the Lambda defaults (Secrets Manager, postgres.js, Sentry); other runtimes
// (e.g. the Cloudflare cron Worker in apps/cf-jobs) pass their own connection and reporters.
import {
	EPHEMERAL_HOST_AFTER_MS,
	OFFLINE_HOST_AFTER_MS,
	reconcileExpiredEphemeralHosts,
	reconcileExpiredOfflineHosts,
	type ExpiredHostReconciliationResult,
} from './expired-hosts'
import { reconcileLostSessions, type LostSessionReconciliationResult } from './lost-sessions'
import {
	reconcileStaleDaemons,
	STALE_DAEMON_AFTER_MS,
	type Database,
	type StaleDaemonReconciliationResult,
} from './stale-daemons'

export type DatabaseConnection = {
	db: Database
	close: () => Promise<void>
}

export type SweepResult = {
	success: true
	invocationTime: bigint
	staleDaemonCutoff: bigint
	ephemeralHostCutoff: bigint
	offlineHostCutoff: bigint
	staleDaemons: StaleDaemonReconciliationResult
	lostSessions: LostSessionReconciliationResult
	expiredEphemeralHosts: ExpiredHostReconciliationResult
	expiredOfflineHosts: ExpiredHostReconciliationResult
}

export type SweepOptions = {
	now?: () => number
	loadDatabaseUrl?: () => Promise<string>
	createDatabaseConnection?: (databaseUrl: string) => Promise<DatabaseConnection>
	reconcileStaleDaemons?: (db: Database, cutoff: bigint) => Promise<StaleDaemonReconciliationResult>
	reconcileLostSessions?: (db: Database, now: bigint) => Promise<LostSessionReconciliationResult>
	reconcileExpiredEphemeralHosts?: (db: Database, cutoff: bigint) => Promise<ExpiredHostReconciliationResult>
	reconcileExpiredOfflineHosts?: (db: Database, cutoff: bigint) => Promise<ExpiredHostReconciliationResult>
	captureException?: (error: unknown) => void
	flushSentry?: () => Promise<unknown>
	logSummary?: (result: SweepResult) => void
}

export type SweepDependencies = SweepOptions &
	Required<Pick<SweepOptions, 'loadDatabaseUrl' | 'createDatabaseConnection'>>

/** Runs the four sweeper passes in order on one connection. */
export async function runSweepPasses(options: SweepDependencies): Promise<SweepResult> {
	const invocationTime = BigInt((options.now ?? Date.now)())
	const staleDaemonCutoff = invocationTime - BigInt(STALE_DAEMON_AFTER_MS)
	const ephemeralHostCutoff = invocationTime - BigInt(EPHEMERAL_HOST_AFTER_MS)
	const offlineHostCutoff = invocationTime - BigInt(OFFLINE_HOST_AFTER_MS)
	const runDaemonPass = options.reconcileStaleDaemons ?? reconcileStaleDaemons
	const runLostPass = options.reconcileLostSessions ?? reconcileLostSessions
	const runEphemeralPass = options.reconcileExpiredEphemeralHosts ?? reconcileExpiredEphemeralHosts
	const runOfflinePass = options.reconcileExpiredOfflineHosts ?? reconcileExpiredOfflineHosts
	const captureException = options.captureException ?? (() => {})
	const flushSentry = options.flushSentry ?? (async () => {})
	const logSummary =
		options.logSummary ?? ((result) => console.log({ event: 'session_reconciliation_completed', ...result }))
	let connection: DatabaseConnection | undefined

	try {
		const databaseUrl = await options.loadDatabaseUrl()
		connection = await options.createDatabaseConnection(databaseUrl)
		const staleDaemons = await runDaemonPass(connection.db, staleDaemonCutoff)
		const lostSessions = await runLostPass(connection.db, invocationTime)
		const expiredEphemeralHosts = await runEphemeralPass(connection.db, ephemeralHostCutoff)
		const expiredOfflineHosts = await runOfflinePass(connection.db, offlineHostCutoff)
		const result: SweepResult = {
			success: true,
			invocationTime,
			staleDaemonCutoff,
			ephemeralHostCutoff,
			offlineHostCutoff,
			staleDaemons,
			lostSessions,
			expiredEphemeralHosts,
			expiredOfflineHosts,
		}
		logSummary(result)
		return result
	} catch (error) {
		captureException(error)
		throw error
	} finally {
		try {
			await flushSentry()
		} finally {
			await connection?.close()
		}
	}
}
