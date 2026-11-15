// Runtime-neutral snapshot retention logic: no Sentry, no AWS SDK, no driver construction.
// index.ts is the Lambda entry point; apps/cf-jobs calls this from a Cloudflare cron Worker.
import { codelayerAgentStateSnapshots } from '@humanlayer/db/tables/codelayer-agent-state-snapshots'
import { getTableColumns, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getTableName } from 'drizzle-orm/table'

const SNAPSHOT_RETENTION_BATCH_SIZE = 250
const SNAPSHOT_RETENTION_MAX_BATCHES = 25
const SNAPSHOT_RETENTION_SLEEP_MS = 250
const SNAPSHOT_RETENTION_MIN_REMAINING_MS = 15_000
const SNAPSHOT_RETENTION_AGE_MS = 90 * 24 * 60 * 60 * 1000
const STATEMENT_TIMEOUT_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000

export type Db = PostgresJsDatabase<Record<string, never>>

export type CleanupOptions = {
	now?: number
	expiresBefore?: number
	getRemainingTimeInMillis?: () => number
	sleep?: (ms: number) => Promise<void>
	tombstoneBatch?: (expiresBefore: number, now: number) => Promise<CleanupBatchResult>
}

export type CleanupBatchResult = {
	rows: number
	approxBytesFreed: number
}

export type CleanupResult = {
	success: true
	batches: number
	tombstonedRows: number
	approxBytesFreed: number
	stoppedReason: 'no_eligible_rows' | 'max_batches' | 'time_budget'
	expiresBefore: number
	startedAt: string
	finishedAt: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const snapshotTableName = getTableName(codelayerAgentStateSnapshots)
const snapshotColumns = getTableColumns(codelayerAgentStateSnapshots)
const snapshotTable = sql.identifier(snapshotTableName)
const batchTable = sql.identifier('batch')
const col = (name: string) => sql.identifier(name)
const snapshotCol = (name: string) => sql`${snapshotTable}.${sql.identifier(name)}`
const batchCol = (name: string) => sql`${batchTable}.${sql.identifier(name)}`

function getReturnedRows(result: unknown): unknown[] {
	if (Array.isArray(result)) {
		return result
	}

	if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
		return result.rows
	}

	return []
}

function getBatchResult(result: unknown): CleanupBatchResult {
	const rows = getReturnedRows(result)
	return {
		rows: rows.length,
		approxBytesFreed: rows.reduce<number>((total, row) => {
			if (!row || typeof row !== 'object' || !('approx_bytes_freed' in row)) {
				return total
			}

			const bytes = Number(row.approx_bytes_freed)
			return Number.isFinite(bytes) ? total + bytes : total
		}, 0),
	}
}

function hasTimeForAnotherBatch(getRemainingTimeInMillis?: () => number) {
	return !getRemainingTimeInMillis || getRemainingTimeInMillis() > SNAPSHOT_RETENTION_MIN_REMAINING_MS
}

async function tombstoneExpiredSnapshotBatch(db: Db, expiresBefore: number, now: number) {
	console.log('Starting CodeLayer snapshot retention batch', {
		expiresBefore,
		expiresBeforeIso: new Date(expiresBefore).toISOString(),
		batchSize: SNAPSHOT_RETENTION_BATCH_SIZE,
		statementTimeoutMs: STATEMENT_TIMEOUT_MS,
		lockTimeoutMs: LOCK_TIMEOUT_MS,
	})

	const result = await db.transaction(async (tx) => {
		await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))
		await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`))

		return tx.execute(sql`
			WITH ${batchTable} AS (
				SELECT ${col(snapshotColumns.id.name)}, pg_column_size(${col(snapshotColumns.state.name)}) AS approx_bytes_freed
				FROM ${snapshotTable}
				WHERE ${col(snapshotColumns.created_at.name)} < ${BigInt(expiresBefore)}
					AND ${col(snapshotColumns.state.name)} IS NOT NULL
					AND ${col(snapshotColumns.tombstoned_at.name)} IS NULL
				ORDER BY ${col(snapshotColumns.created_at.name)} ASC, ${col(snapshotColumns.id.name)} ASC
				LIMIT ${SNAPSHOT_RETENTION_BATCH_SIZE}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE ${snapshotTable}
			SET
				${col(snapshotColumns.state.name)} = NULL,
				${col(snapshotColumns.tombstoned_at.name)} = ${BigInt(now)},
				${col(snapshotColumns.tombstone_reason.name)} = 'retention_expired',
				${col(snapshotColumns.updated_at.name)} = ${BigInt(now)}
			FROM ${batchTable}
			WHERE ${snapshotCol(snapshotColumns.id.name)} = ${batchCol(snapshotColumns.id.name)}
			RETURNING ${snapshotCol(snapshotColumns.id.name)}, ${batchCol('approx_bytes_freed')}
		`)
	})

	const batchResult = getBatchResult(result)
	console.log('Finished CodeLayer snapshot retention batch', batchResult)
	return batchResult
}

export async function cleanupExpiredCodelayerForkSnapshots(
	db: Db,
	options: CleanupOptions = {},
): Promise<CleanupResult> {
	const startedAt = new Date().toISOString()
	const now = options.now ?? Date.now()
	const expiresBefore = options.expiresBefore ?? now - SNAPSHOT_RETENTION_AGE_MS
	const sleepFn = options.sleep ?? sleep
	const tombstoneBatch =
		options.tombstoneBatch ?? ((expiresBefore, now) => tombstoneExpiredSnapshotBatch(db, expiresBefore, now))
	let batches = 0
	let tombstonedRows = 0
	let approxBytesFreed = 0
	let stoppedReason: CleanupResult['stoppedReason'] = 'max_batches'

	console.log('Starting CodeLayer snapshot retention cleanup', {
		startedAt,
		now,
		expiresBefore,
		expiresBeforeIso: new Date(expiresBefore).toISOString(),
		retentionAgeMs: SNAPSHOT_RETENTION_AGE_MS,
		batchSize: SNAPSHOT_RETENTION_BATCH_SIZE,
		maxBatches: SNAPSHOT_RETENTION_MAX_BATCHES,
		sleepMs: SNAPSHOT_RETENTION_SLEEP_MS,
		minRemainingMs: SNAPSHOT_RETENTION_MIN_REMAINING_MS,
	})

	while (batches < SNAPSHOT_RETENTION_MAX_BATCHES) {
		const remainingTimeMs = options.getRemainingTimeInMillis?.()
		console.log('Checking CodeLayer snapshot retention loop budget', {
			batches,
			tombstonedRows,
			approxBytesFreed,
			remainingTimeMs,
		})

		if (!hasTimeForAnotherBatch(options.getRemainingTimeInMillis)) {
			stoppedReason = 'time_budget'
			console.log('Stopping CodeLayer snapshot retention cleanup due to time budget', {
				remainingTimeMs: options.getRemainingTimeInMillis?.(),
				minRemainingMs: SNAPSHOT_RETENTION_MIN_REMAINING_MS,
			})
			break
		}

		const batchResult = await tombstoneBatch(expiresBefore, now)
		if (batchResult.rows === 0) {
			stoppedReason = 'no_eligible_rows'
			console.log('Stopping CodeLayer snapshot retention cleanup because no eligible rows remain')
			break
		}

		batches += 1
		tombstonedRows += batchResult.rows
		approxBytesFreed += batchResult.approxBytesFreed
		console.log('Tombstoned expired CodeLayer snapshot batch', {
			batchRows: batchResult.rows,
			batchApproxBytesFreed: batchResult.approxBytesFreed,
			batches,
			tombstonedRows,
			approxBytesFreed,
		})

		if (batches < SNAPSHOT_RETENTION_MAX_BATCHES) {
			console.log('Sleeping between CodeLayer snapshot retention batches', {
				sleepMs: SNAPSHOT_RETENTION_SLEEP_MS,
			})
			await sleepFn(SNAPSHOT_RETENTION_SLEEP_MS)
		}
	}

	console.log('Finished CodeLayer snapshot retention cleanup', {
		batches,
		tombstonedRows,
		approxBytesFreed,
		stoppedReason,
	})

	return {
		success: true,
		batches,
		tombstonedRows,
		approxBytesFreed,
		stoppedReason,
		expiresBefore,
		startedAt,
		finishedAt: new Date().toISOString(),
	}
}
