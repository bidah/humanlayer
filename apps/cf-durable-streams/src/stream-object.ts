/**
 * One SQLite-backed Durable Object per stream path.
 *
 * All protocol state lives in SQLite so an evicted object rebuilds itself on
 * the next request; only live readers (SSE / long-poll waiters) are kept in
 * memory and are woken on every mutation.
 */
import { DurableObject } from 'cloudflare:workers'

import {
	advanceOffset,
	bytesToBase64,
	concatBytes,
	decodeText,
	encodeText,
	etagFor,
	formatJsonMessages,
	generateResponseCursor,
	isJsonContentType,
	needsBase64,
	normalizeContentType,
	parseJsonFragment,
	parseStrictInteger,
	parseTtl,
	PRODUCER_EPOCH_HEADER,
	PRODUCER_EXPECTED_SEQ_HEADER,
	PRODUCER_ID_HEADER,
	PRODUCER_RECEIVED_SEQ_HEADER,
	PRODUCER_SEQ_HEADER,
	processJsonAppend,
	ProtocolError,
	sseEvent,
	type StoredMessage,
	STREAM_CLOSED_HEADER,
	STREAM_CURSOR_HEADER,
	STREAM_EXPIRES_AT_HEADER,
	STREAM_FORK_OFFSET_HEADER,
	STREAM_FORK_SUB_OFFSET_HEADER,
	STREAM_FORKED_FROM_HEADER,
	STREAM_OFFSET_HEADER,
	STREAM_SEQ_HEADER,
	STREAM_SSE_DATA_ENCODING_HEADER,
	STREAM_TTL_HEADER,
	STREAM_UP_TO_DATE_HEADER,
	textResponse,
	VALID_FORK_OFFSET,
	VALID_READ_OFFSET,
	ZERO_OFFSET,
} from './protocol'

export interface Env {
	STREAMS: DurableObjectNamespace<DurableStreamObject>
	LONG_POLL_TIMEOUT_MS?: string
	SSE_MAX_DURATION_MS?: string
	SSE_KEEPALIVE_MS?: string
	MAX_APPEND_BYTES?: string
	MAX_STREAM_BYTES?: string
}

const MiB = 1024 * 1024
/** SQLite rows/blobs in Durable Objects cap at 2 MB; stay well under. */
const CHUNK_BYTES = 1 * MiB
/** Soft cap on bytes returned by one catch-up response or one SSE data event. */
const READ_BUDGET_BYTES = 4 * MiB
const PRODUCER_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const FORK_COPY_BUDGET_BYTES = 8 * MiB

interface ClosedBy {
	producerId: string
	epoch: number
	seq: number
}

interface StreamMeta {
	path: string
	contentType: string
	ttlSeconds?: number
	expiresAt?: string
	createdAt: number
	lastAccessedAt: number
	closed: boolean
	closedBy?: ClosedBy
	/** Last Stream-Seq value (writer coordination, lexicographic). */
	lastSeq?: string
	currentOffset: string
	totalBytes: number
	refCount: number
	softDeleted: boolean
	forkedFrom?: string
	forkOffset?: string
	forkSubOffset?: number
}

/** SSE control event payload (Protocol Section 5.8); undefined fields are dropped by JSON.stringify. */
interface SseControl {
	streamNextOffset: string
	streamCursor: string
	upToDate: true | undefined
}

interface ProducerState {
	epoch: number
	lastSeq: number
}

type ProducerResult =
	| { status: 'accepted'; producerId: string; epoch: number; seq: number }
	| { status: 'duplicate'; lastSeq: number }
	| { status: 'stale_epoch'; currentEpoch: number }
	| { status: 'invalid_epoch_seq' }
	| { status: 'sequence_gap'; expectedSeq: number; receivedSeq: number }

interface ProducerHeaders {
	producerId: string
	epoch: number
	seq: number
}

export type ForkAcquireResult =
	| { ok: false; status: number; message: string }
	| {
			ok: true
			contentType: string
			ttlSeconds?: number
			expiresAt?: string
			forkOffset: string
			prefix?: Uint8Array
	  }

interface ReadResult {
	messages: Array<StoredMessage>
	/** True when the returned batch ends at the stream tail. */
	upToDate: boolean
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
	bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
		? bytes.buffer
		: (bytes.slice().buffer as ArrayBuffer)

function header(request: Request, ...names: Array<string>): string | undefined {
	for (const name of names) {
		const value = request.headers.get(name)
		if (value !== null) return value
	}
	return undefined
}

export class DurableStreamObject extends DurableObject<Env> {
	private readonly sql: SqlStorage
	private meta: StreamMeta | null = null
	/** lastAccessedAt value that is persisted; memory may be ahead of it. */
	private persistedAccessAt = 0
	/** Bumped whenever the stream is purged so live readers of the old incarnation stop. */
	private generation = 0
	private waiters = new Set<() => void>()

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.sql = ctx.storage.sql
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS messages (
				seq INTEGER PRIMARY KEY,
				off TEXT NOT NULL UNIQUE,
				size INTEGER NOT NULL,
				chunks INTEGER NOT NULL,
				data BLOB
			);
			CREATE TABLE IF NOT EXISTS chunks (
				seq INTEGER NOT NULL,
				idx INTEGER NOT NULL,
				data BLOB NOT NULL,
				PRIMARY KEY (seq, idx)
			);
			CREATE TABLE IF NOT EXISTS producers (
				id TEXT PRIMARY KEY,
				epoch INTEGER NOT NULL,
				last_seq INTEGER NOT NULL,
				last_updated INTEGER NOT NULL
			);
		`)
		const row = this.sql.exec<{ json: string }>('SELECT json FROM meta WHERE id = 1').toArray()[0]
		if (row) {
			this.meta = JSON.parse(row.json) as StreamMeta
			this.persistedAccessAt = this.meta.lastAccessedAt
		}
	}

	// ==========================================================================
	// Configuration
	// ==========================================================================

	private numberVar(value: string | undefined, fallback: number): number {
		const n = value === undefined ? Number.NaN : Number(value)
		return Number.isFinite(n) && n > 0 ? n : fallback
	}
	private get longPollTimeoutMs() {
		return this.numberVar(this.env.LONG_POLL_TIMEOUT_MS, 30_000)
	}
	private get sseMaxDurationMs() {
		return this.numberVar(this.env.SSE_MAX_DURATION_MS, 60_000)
	}
	private get sseKeepaliveMs() {
		return this.numberVar(this.env.SSE_KEEPALIVE_MS, 15_000)
	}
	private get maxAppendBytes() {
		return this.numberVar(this.env.MAX_APPEND_BYTES, 16 * MiB)
	}
	private get maxStreamBytes() {
		return this.numberVar(this.env.MAX_STREAM_BYTES, 100 * MiB)
	}

	// ==========================================================================
	// Persistence helpers
	// ==========================================================================

	private saveMeta(meta: StreamMeta): void {
		this.meta = meta
		this.persistedAccessAt = meta.lastAccessedAt
		this.sql.exec('INSERT OR REPLACE INTO meta (id, json) VALUES (1, ?)', JSON.stringify(meta))
	}

	private expiryTime(meta: StreamMeta): number | undefined {
		let expiry: number | undefined
		if (meta.expiresAt) {
			const t = new Date(meta.expiresAt).getTime()
			expiry = Number.isFinite(t) ? t : 0
		}
		if (meta.ttlSeconds !== undefined) {
			const t = meta.lastAccessedAt + meta.ttlSeconds * 1000
			expiry = expiry === undefined ? t : Math.min(expiry, t)
		}
		return expiry
	}

	private async scheduleExpiryAlarm(meta: StreamMeta): Promise<void> {
		const expiry = this.expiryTime(meta)
		if (expiry === undefined) return
		const current = await this.ctx.storage.getAlarm()
		if (current === null || current > expiry) await this.ctx.storage.setAlarm(expiry)
	}

	/**
	 * Sliding TTL renewal (GET / POST, never HEAD). Memory is always current;
	 * the persisted value is throttled to 10% of the TTL (max 60s) to avoid a
	 * storage write on every read.
	 */
	private touch(): void {
		const meta = this.meta
		if (!meta) return
		const now = Date.now()
		meta.lastAccessedAt = now
		if (meta.ttlSeconds === undefined) return
		const throttle = Math.min(60_000, meta.ttlSeconds * 100)
		if (now - this.persistedAccessAt >= throttle) this.saveMeta(meta)
	}

	/** Remove every trace of the stream and wake live readers. */
	private purge(): string | undefined {
		const forkedFrom = this.meta?.forkedFrom
		this.sql.exec('DELETE FROM messages; DELETE FROM chunks; DELETE FROM producers; DELETE FROM meta;')
		this.meta = null
		this.persistedAccessAt = 0
		this.generation++
		this.notify()
		void this.ctx.storage.deleteAlarm()
		return forkedFrom
	}

	private async releaseSource(sourcePath: string | undefined): Promise<void> {
		if (!sourcePath) return
		try {
			await this.env.STREAMS.get(this.env.STREAMS.idFromName(sourcePath)).forkRelease()
		} catch (err) {
			console.error('fork release failed', sourcePath, err)
		}
	}

	/**
	 * The stream if it exists and is not expired. Expired streams with forks
	 * become soft-deleted; otherwise they are purged.
	 */
	private live(): StreamMeta | null {
		const meta = this.meta
		if (!meta) return null
		const expiry = this.expiryTime(meta)
		if (expiry !== undefined && Date.now() >= expiry) {
			if (meta.refCount > 0) {
				if (!meta.softDeleted) {
					meta.softDeleted = true
					this.saveMeta(meta)
				}
				return meta
			}
			const source = this.purge()
			if (source) this.ctx.waitUntil(this.releaseSource(source))
			return null
		}
		return meta
	}

	private insertMessage(offset: string, data: Uint8Array): void {
		if (data.byteLength <= CHUNK_BYTES) {
			this.sql.exec(
				'INSERT INTO messages (off, size, chunks, data) VALUES (?, ?, 0, ?)',
				offset,
				data.byteLength,
				toArrayBuffer(data),
			)
			return
		}
		const count = Math.ceil(data.byteLength / CHUNK_BYTES)
		const { seq } = this.sql
			.exec<{ seq: number }>(
				'INSERT INTO messages (off, size, chunks, data) VALUES (?, ?, ?, NULL) RETURNING seq',
				offset,
				data.byteLength,
				count,
			)
			.one()
		for (let idx = 0; idx < count; idx++) {
			const part = data.subarray(idx * CHUNK_BYTES, (idx + 1) * CHUNK_BYTES)
			this.sql.exec('INSERT INTO chunks (seq, idx, data) VALUES (?, ?, ?)', seq, idx, toArrayBuffer(part))
		}
	}

	private loadChunks(seq: number): Uint8Array {
		const parts = this.sql
			.exec<{ data: ArrayBuffer }>('SELECT data FROM chunks WHERE seq = ? ORDER BY idx', seq)
			.toArray()
			.map((row) => new Uint8Array(row.data))
		return concatBytes(parts)
	}

	/**
	 * Messages strictly after `after` (null = from the beginning), at least one
	 * message and otherwise at most `budget` bytes. Optionally capped at an
	 * inclusive upper offset (used when copying into a fork).
	 */
	private readMessages(after: string | null, budget = READ_BUDGET_BYTES, capInclusive?: string): ReadResult {
		const rows = this.sql.exec<{
			seq: number
			off: string
			size: number
			chunks: number
			data: ArrayBuffer | null
		}>(
			// Offsets are digits and '_', so '~' sorts after every stored offset.
			'SELECT seq, off, size, chunks, data FROM messages WHERE off > ? AND off <= ? ORDER BY off',
			after ?? '',
			capInclusive ?? '~',
		)
		const picked: Array<{ seq: number; off: string; chunks: number; data: ArrayBuffer | null }> = []
		let bytes = 0
		let more = false
		for (const row of rows) {
			if (picked.length > 0 && bytes + row.size > budget) {
				more = true
				break
			}
			picked.push({ seq: row.seq, off: row.off, chunks: row.chunks, data: row.data })
			bytes += row.size
		}
		const messages = picked.map((row) => ({
			offset: row.off,
			data: row.chunks > 0 ? this.loadChunks(row.seq) : new Uint8Array(row.data ?? new ArrayBuffer(0)),
		}))
		return { messages, upToDate: !more }
	}

	// ==========================================================================
	// Live readers
	// ==========================================================================

	private notify(): void {
		const waiters = [...this.waiters]
		this.waiters.clear()
		for (const wake of waiters) wake()
	}

	/** Resolves true when woken by a mutation, false on timeout/abort. */
	private waitForChange(timeoutMs: number, abort?: Promise<unknown>): Promise<boolean> {
		return new Promise((resolve) => {
			let done = false
			const finish = (changed: boolean) => {
				if (done) return
				done = true
				clearTimeout(timer)
				this.waiters.delete(wake)
				resolve(changed)
			}
			const wake = () => finish(true)
			const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
			this.waiters.add(wake)
			abort?.then(
				() => finish(false),
				() => finish(false),
			)
		})
	}

	// ==========================================================================
	// HTTP entry point
	// ==========================================================================

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname
		try {
			switch (request.method.toUpperCase()) {
				case 'PUT':
					return await this.handleCreate(request, url, path)
				case 'HEAD':
					return this.handleHead(path)
				case 'GET':
					return await this.handleRead(request, url, path)
				case 'POST':
					return await this.handleAppend(request)
				case 'DELETE':
					return await this.handleDelete()
				default:
					return textResponse(405, 'Method not allowed')
			}
		} catch (err) {
			if (err instanceof ProtocolError) return textResponse(err.status, err.message, err.headers)
			throw err
		}
	}

	private async readBody(request: Request): Promise<Uint8Array> {
		const declared = Number(request.headers.get('content-length') ?? '0')
		if (Number.isFinite(declared) && declared > this.maxAppendBytes) {
			throw new ProtocolError(413, 'Payload too large')
		}
		const body = new Uint8Array(await request.arrayBuffer())
		if (body.byteLength > this.maxAppendBytes) throw new ProtocolError(413, 'Payload too large')
		return body
	}

	// ==========================================================================
	// PUT - create
	// ==========================================================================

	private async handleCreate(request: Request, url: URL, path: string): Promise<Response> {
		let contentType: string | undefined = request.headers.get('content-type') ?? undefined
		const forkedFrom = header(request, STREAM_FORKED_FROM_HEADER) || undefined
		const forkOffsetHeader = header(request, STREAM_FORK_OFFSET_HEADER)
		const forkSubOffsetHeader = header(request, STREAM_FORK_SUB_OFFSET_HEADER)

		if (!contentType || contentType.trim() === '' || !/^[\w-]+\/[\w-]+/.test(contentType)) {
			contentType = forkedFrom ? undefined : 'application/octet-stream'
		}

		const ttlHeader = header(request, STREAM_TTL_HEADER)
		const expiresAtHeader = header(request, STREAM_EXPIRES_AT_HEADER)
		const createClosed = header(request, STREAM_CLOSED_HEADER) === 'true'

		if (ttlHeader && expiresAtHeader) {
			return textResponse(400, 'Cannot specify both Stream-TTL and Stream-Expires-At')
		}
		let ttlSeconds: number | undefined
		if (ttlHeader) {
			ttlSeconds = parseTtl(ttlHeader)
			if (ttlSeconds === undefined) return textResponse(400, 'Invalid Stream-TTL value')
		}
		if (expiresAtHeader && Number.isNaN(new Date(expiresAtHeader).getTime())) {
			return textResponse(400, 'Invalid Stream-Expires-At timestamp')
		}
		if (forkOffsetHeader && !VALID_FORK_OFFSET.test(forkOffsetHeader)) {
			return textResponse(400, 'Invalid Stream-Fork-Offset format')
		}
		let forkSubOffset: number | undefined
		if (forkSubOffsetHeader !== undefined) {
			if (!forkedFrom) return textResponse(400, 'Stream-Fork-Sub-Offset requires Stream-Forked-From')
			if (!/^(0|[1-9]\d*)$/.test(forkSubOffsetHeader)) {
				return textResponse(400, 'Invalid Stream-Fork-Sub-Offset format')
			}
			forkSubOffset = Number.parseInt(forkSubOffsetHeader, 10)
		}

		const body = await this.readBody(request)

		const existing = this.live()
		if (existing) {
			if (existing.softDeleted) {
				return textResponse(
					409,
					'stream was deleted but still has active forks — path cannot be reused until all forks are removed',
				)
			}
			const isFork = forkedFrom !== undefined || existing.forkedFrom !== undefined
			const contentTypeMatches =
				(isFork && contentType === undefined) ||
				(normalizeContentType(contentType) || 'application/octet-stream') ===
					(normalizeContentType(existing.contentType) || 'application/octet-stream')
			const ttlMatches =
				(isFork && ttlSeconds === undefined && expiresAtHeader === undefined) ||
				(ttlSeconds === existing.ttlSeconds && expiresAtHeader === existing.expiresAt)
			const matches =
				contentTypeMatches &&
				ttlMatches &&
				createClosed === existing.closed &&
				forkedFrom === existing.forkedFrom &&
				(forkOffsetHeader === undefined || forkOffsetHeader === existing.forkOffset) &&
				(forkSubOffset ?? 0) === (existing.forkSubOffset ?? 0)
			if (!matches) return textResponse(409, 'Stream already exists with different configuration')
			return new Response(null, { status: 200, headers: this.createHeaders(existing) })
		}

		let meta: StreamMeta
		if (forkedFrom) {
			const result = await this.createFork(path, {
				forkedFrom,
				contentType,
				ttlSeconds,
				expiresAt: expiresAtHeader,
				forkOffset: forkOffsetHeader,
				forkSubOffset,
				closed: createClosed,
				body,
			})
			if (result instanceof Response) return result
			meta = result
		} else {
			const now = Date.now()
			const draft: StreamMeta = {
				path,
				contentType: contentType ?? 'application/octet-stream',
				ttlSeconds,
				expiresAt: expiresAtHeader,
				createdAt: now,
				lastAccessedAt: now,
				closed: createClosed,
				currentOffset: ZERO_OFFSET,
				totalBytes: 0,
				refCount: 0,
				softDeleted: false,
			}
			const initial = this.prepareData(draft, body, true)
			this.ctx.storage.transactionSync(() => {
				this.purgeRowsOnly()
				if (initial && initial.byteLength > 0) this.appendRow(draft, initial)
				this.saveMeta(draft)
			})
			meta = draft
		}
		await this.scheduleExpiryAlarm(meta)
		this.notify()

		const headers = this.createHeaders(meta)
		headers.location = `${url.origin}${path}`
		return new Response(null, { status: 201, headers })
	}

	private createHeaders(meta: StreamMeta): Record<string, string> {
		const headers: Record<string, string> = {
			'content-type': meta.contentType,
			[STREAM_OFFSET_HEADER]: meta.currentOffset,
		}
		if (meta.closed) headers[STREAM_CLOSED_HEADER] = 'true'
		return headers
	}

	/** Leftover rows from an expired incarnation must not leak into a new one. */
	private purgeRowsOnly(): void {
		this.sql.exec('DELETE FROM messages; DELETE FROM chunks; DELETE FROM producers;')
	}

	/** Validate/normalise data for this stream's content type. Throws ProtocolError. */
	private prepareData(meta: StreamMeta, data: Uint8Array, isInitialCreate: boolean): Uint8Array | null {
		if (data.byteLength === 0) return null
		const processed = isJsonContentType(meta.contentType) ? processJsonAppend(data, isInitialCreate) : data
		if (processed.byteLength === 0) return null
		if (meta.totalBytes + processed.byteLength > this.maxStreamBytes) {
			throw new ProtocolError(413, 'Stream size limit exceeded')
		}
		return processed
	}

	private appendRow(meta: StreamMeta, processed: Uint8Array): string {
		const offset = advanceOffset(meta.currentOffset, processed.byteLength)
		this.insertMessage(offset, processed)
		meta.currentOffset = offset
		meta.totalBytes += processed.byteLength
		return offset
	}

	// ==========================================================================
	// Forks (copy-on-fork: inherited messages are copied with their offsets)
	// ==========================================================================

	private async createFork(
		path: string,
		options: {
			forkedFrom: string
			contentType?: string
			ttlSeconds?: number
			expiresAt?: string
			forkOffset?: string
			forkSubOffset?: number
			closed: boolean
			body: Uint8Array
		},
	): Promise<StreamMeta | Response> {
		if (!options.forkedFrom.startsWith('/v1/stream/') || options.forkedFrom === path) {
			return textResponse(404, 'Source stream not found')
		}
		const source = this.env.STREAMS.get(this.env.STREAMS.idFromName(options.forkedFrom))
		let created: StreamMeta | Response | undefined
		await this.ctx.blockConcurrencyWhile(async () => {
			// Another request may have created the stream while we waited.
			if (this.live()) {
				created = textResponse(409, 'Stream already exists with different configuration')
				return
			}
			const acquired = await source.forkAcquire({
				contentType: options.contentType,
				forkOffset: options.forkOffset,
				forkSubOffset: options.forkSubOffset,
			})
			if (!acquired.ok) {
				created = textResponse(acquired.status, acquired.message)
				return
			}
			try {
				const now = Date.now()
				let ttlSeconds = options.ttlSeconds
				let expiresAt = options.expiresAt
				if (ttlSeconds === undefined && !expiresAt) {
					ttlSeconds = acquired.ttlSeconds
					expiresAt = acquired.ttlSeconds === undefined ? acquired.expiresAt : undefined
				} else if (ttlSeconds !== undefined) {
					expiresAt = undefined
				}
				const meta: StreamMeta = {
					path,
					contentType: acquired.contentType,
					ttlSeconds,
					expiresAt,
					createdAt: now,
					lastAccessedAt: now,
					closed: options.closed,
					currentOffset: acquired.forkOffset,
					totalBytes: 0,
					refCount: 0,
					softDeleted: false,
					forkedFrom: options.forkedFrom,
					forkOffset: acquired.forkOffset,
				}
				this.purgeRowsOnly()
				// Copy inherited messages page by page.
				let after: string | null = null
				for (;;) {
					const page: Array<StoredMessage> = await source.forkRead(
						after,
						acquired.forkOffset,
						FORK_COPY_BUDGET_BYTES,
					)
					if (page.length === 0) break
					this.ctx.storage.transactionSync(() => {
						for (const message of page) {
							this.insertMessage(message.offset, message.data)
							meta.totalBytes += message.data.byteLength
						}
					})
					after = page.at(-1)?.offset ?? null
				}
				const initial = this.prepareData(meta, options.body, true)
				this.ctx.storage.transactionSync(() => {
					if (acquired.prefix && acquired.prefix.byteLength > 0) {
						this.appendRow(meta, acquired.prefix)
						meta.forkSubOffset = options.forkSubOffset
					}
					if (initial) this.appendRow(meta, initial)
					this.saveMeta(meta)
				})
				created = meta
			} catch (err) {
				this.purgeRowsOnly()
				await source.forkRelease()
				if (err instanceof ProtocolError) {
					created = textResponse(err.status, err.message, err.headers)
					return
				}
				throw err
			}
		})
		return created ?? textResponse(500, 'Fork creation failed')
	}

	/** RPC: called by a fork being created from this stream. */
	async forkAcquire(options: {
		contentType?: string
		forkOffset?: string
		forkSubOffset?: number
	}): Promise<ForkAcquireResult> {
		const meta = this.live()
		if (!meta) return { ok: false, status: 404, message: 'Source stream not found' }
		if (meta.softDeleted) {
			return { ok: false, status: 409, message: 'source stream was deleted but still has active forks' }
		}
		if (
			options.contentType &&
			options.contentType.trim() !== '' &&
			normalizeContentType(options.contentType) !== normalizeContentType(meta.contentType)
		) {
			return { ok: false, status: 409, message: 'Content type mismatch with source stream' }
		}
		const forkOffset = options.forkOffset ?? meta.currentOffset
		if (forkOffset < ZERO_OFFSET || meta.currentOffset < forkOffset) {
			return { ok: false, status: 400, message: 'Fork offset beyond source stream length' }
		}
		let prefix: Uint8Array | undefined
		if (options.forkSubOffset && options.forkSubOffset > 0) {
			const first = this.readMessages(forkOffset, 1).messages[0]
			if (!first) return { ok: false, status: 400, message: 'Invalid fork sub-offset' }
			if (isJsonContentType(meta.contentType)) {
				let values: Array<unknown>
				try {
					values = parseJsonFragment(first.data)
				} catch {
					return { ok: false, status: 400, message: 'Invalid fork sub-offset' }
				}
				if (options.forkSubOffset > values.length) {
					return { ok: false, status: 400, message: 'Invalid fork sub-offset' }
				}
				prefix = encodeText(
					`${values
						.slice(0, options.forkSubOffset)
						.map((v) => JSON.stringify(v))
						.join(',')},`,
				)
			} else {
				if (options.forkSubOffset > first.data.byteLength) {
					return { ok: false, status: 400, message: 'Invalid fork sub-offset' }
				}
				prefix = first.data.slice(0, options.forkSubOffset)
			}
		}
		meta.refCount++
		this.saveMeta(meta)
		return {
			ok: true,
			contentType: meta.contentType,
			ttlSeconds: meta.ttlSeconds,
			expiresAt: meta.expiresAt,
			forkOffset,
			prefix,
		}
	}

	/** RPC: page of messages (after, cap] for fork copying. Reads through soft-deleted state. */
	async forkRead(after: string | null, capInclusive: string, budget: number): Promise<Array<StoredMessage>> {
		if (!this.meta) return []
		return this.readMessages(after, budget, capInclusive).messages
	}

	/** RPC: a fork of this stream was deleted or expired. */
	async forkRelease(): Promise<void> {
		const meta = this.meta
		if (!meta) return
		meta.refCount = Math.max(0, meta.refCount - 1)
		if (meta.refCount === 0 && meta.softDeleted) {
			const source = this.purge()
			await this.releaseSource(source)
			return
		}
		this.saveMeta(meta)
	}

	// ==========================================================================
	// HEAD
	// ==========================================================================

	private handleHead(path: string): Response {
		const meta = this.live()
		if (!meta) return new Response(null, { status: 404, headers: { 'content-type': 'text/plain' } })
		if (meta.softDeleted) return new Response(null, { status: 410, headers: { 'content-type': 'text/plain' } })
		const headers: Record<string, string> = {
			[STREAM_OFFSET_HEADER]: meta.currentOffset,
			'cache-control': 'no-store',
			'content-type': meta.contentType,
			etag: etagFor(path, '-1', meta.currentOffset, meta.closed),
		}
		if (meta.closed) headers[STREAM_CLOSED_HEADER] = 'true'
		if (meta.ttlSeconds !== undefined) headers[STREAM_TTL_HEADER] = String(meta.ttlSeconds)
		if (meta.expiresAt) headers[STREAM_EXPIRES_AT_HEADER] = meta.expiresAt
		return new Response(null, { status: 200, headers })
	}

	// ==========================================================================
	// GET - catch-up, long-poll, SSE
	// ==========================================================================

	private formatBody(meta: StreamMeta, messages: ReadonlyArray<StoredMessage>): string | Uint8Array {
		if (isJsonContentType(meta.contentType)) return formatJsonMessages(messages)
		return concatBytes(messages.map((m) => m.data))
	}

	private async handleRead(request: Request, url: URL, path: string): Promise<Response> {
		const meta = this.live()
		if (!meta) return textResponse(404, 'Stream not found')
		if (meta.softDeleted) return textResponse(410, 'Stream is gone')

		const offsets = url.searchParams.getAll('offset')
		const offset = offsets[0]
		const live = url.searchParams.get('live')
		const cursor = url.searchParams.get('cursor')

		if (offset !== undefined) {
			if (offset === '') return textResponse(400, 'Empty offset parameter')
			if (offsets.length > 1) return textResponse(400, 'Multiple offset parameters not allowed')
			if (!VALID_READ_OFFSET.test(offset)) return textResponse(400, 'Invalid offset format')
		}
		if ((live === 'long-poll' || live === 'sse') && !offset) {
			return textResponse(400, `${live === 'sse' ? 'SSE' : 'Long-poll'} requires offset parameter`)
		}

		if (live === 'sse' && offset !== undefined) {
			const start = offset === 'now' ? meta.currentOffset : offset
			this.touch()
			return this.handleSSE(meta, start, cursor, request.signal)
		}

		const effectiveOffset = offset === 'now' ? meta.currentOffset : offset

		if (offset === 'now' && live !== 'long-poll') {
			this.touch()
			const headers: Record<string, string> = {
				[STREAM_OFFSET_HEADER]: meta.currentOffset,
				[STREAM_UP_TO_DATE_HEADER]: 'true',
				'cache-control': 'no-store',
				'content-type': meta.contentType,
			}
			if (meta.closed) headers[STREAM_CLOSED_HEADER] = 'true'
			return new Response(isJsonContentType(meta.contentType) ? '[]' : '', { status: 200, headers })
		}

		const after = effectiveOffset === undefined || effectiveOffset === '-1' ? null : effectiveOffset
		let result = this.readMessages(after)
		this.touch()

		const clientIsCaughtUp = effectiveOffset !== undefined && effectiveOffset === meta.currentOffset
		if (live === 'long-poll' && clientIsCaughtUp && result.messages.length === 0) {
			if (meta.closed) {
				return new Response(null, {
					status: 204,
					headers: {
						[STREAM_OFFSET_HEADER]: meta.currentOffset,
						[STREAM_UP_TO_DATE_HEADER]: 'true',
						[STREAM_CLOSED_HEADER]: 'true',
					},
				})
			}
			const generation = this.generation
			const deadline = Date.now() + this.longPollTimeoutMs
			const aborted = abortPromise(request.signal)
			for (;;) {
				const remaining = deadline - Date.now()
				const changed = remaining > 0 ? await this.waitForChange(remaining, aborted) : false
				if (this.generation !== generation || !this.meta) return textResponse(404, 'Stream not found')
				this.touch()
				result = this.readMessages(after)
				if (result.messages.length > 0) break
				const current = this.meta
				if (current.closed || !changed) {
					const headers: Record<string, string> = {
						[STREAM_OFFSET_HEADER]: effectiveOffset ?? current.currentOffset,
						[STREAM_UP_TO_DATE_HEADER]: 'true',
						[STREAM_CURSOR_HEADER]: generateResponseCursor(cursor),
					}
					if (current.closed) headers[STREAM_CLOSED_HEADER] = 'true'
					return new Response(null, { status: 204, headers })
				}
			}
		}

		const current = this.meta ?? meta
		const { messages, upToDate } = result
		const responseOffset = messages[messages.length - 1]?.offset ?? current.currentOffset
		const headers: Record<string, string> = {
			'content-type': current.contentType,
			[STREAM_OFFSET_HEADER]: responseOffset,
		}
		if (live === 'long-poll') headers[STREAM_CURSOR_HEADER] = generateResponseCursor(cursor)
		if (upToDate) headers[STREAM_UP_TO_DATE_HEADER] = 'true'
		const atTailClosed = current.closed && upToDate && responseOffset === current.currentOffset
		if (atTailClosed) headers[STREAM_CLOSED_HEADER] = 'true'
		const etag = etagFor(path, offset ?? '-1', responseOffset, atTailClosed)
		headers.etag = etag
		const ifNoneMatch = request.headers.get('if-none-match')
		if (ifNoneMatch && ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } })
		return new Response(this.formatBody(current, messages), { status: 200, headers })
	}

	private handleSSE(meta: StreamMeta, startOffset: string, cursor: string | null, signal: AbortSignal): Response {
		const useBase64 = needsBase64(meta.contentType)
		const isJson = isJsonContentType(meta.contentType)
		const headers: Record<string, string> = {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		}
		if (useBase64) headers[STREAM_SSE_DATA_ENCODING_HEADER] = 'base64'

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
		const writer = writable.getWriter()
		const generation = this.generation
		const closed = writer.closed.then(
			() => undefined,
			() => undefined,
		)
		const disconnected = Promise.race([closed, abortPromise(signal)])
		let connected = true
		void disconnected.then(() => {
			connected = false
		})

		const write = async (text: string) => {
			await writer.write(encodeText(text))
		}

		const pump = async () => {
			const deadline = Date.now() + this.sseMaxDurationMs
			let offset = startOffset
			while (connected) {
				const current = this.meta
				if (!current || this.generation !== generation || current.softDeleted) break
				const after = offset === '-1' ? null : offset
				const { messages, upToDate } = this.readMessages(after)
				// Each data event and its control event go out in one write (one chunk).
				let frame = ''
				if (messages.length > 0) {
					let payload: string
					if (useBase64) payload = bytesToBase64(concatBytes(messages.map((m) => m.data)))
					else if (isJson) payload = formatJsonMessages(messages)
					else payload = decodeText(concatBytes(messages.map((m) => m.data)))
					frame += sseEvent('data', payload)
				}
				const controlOffset = messages[messages.length - 1]?.offset ?? current.currentOffset
				const atTail = upToDate && controlOffset === current.currentOffset
				if (current.closed && atTail) {
					frame += sseEvent(
						'control',
						JSON.stringify({ streamNextOffset: controlOffset, streamClosed: true }),
					)
					await write(frame)
					break
				}
				const control: SseControl = {
					streamNextOffset: controlOffset,
					streamCursor: generateResponseCursor(cursor),
					upToDate: upToDate ? true : undefined,
				}
				frame += sseEvent('control', JSON.stringify(control))
				await write(frame)
				offset = controlOffset
				if (!upToDate) continue
				const remaining = deadline - Date.now()
				// Close periodically so clients reconnect from their last offset.
				if (remaining <= 0) break
				await this.waitForChange(Math.min(this.sseKeepaliveMs, remaining), disconnected)
				if (connected) this.touch()
			}
		}

		void pump()
			.catch(() => undefined)
			.finally(() => {
				connected = false
				writer.close().catch(() => undefined)
			})

		return new Response(readable, { status: 200, headers })
	}

	// ==========================================================================
	// POST - append / close
	// ==========================================================================

	private parseProducerHeaders(request: Request): ProducerHeaders | undefined {
		const producerId = header(request, PRODUCER_ID_HEADER, 'Stream-Producer-Id')
		const epochStr = header(request, PRODUCER_EPOCH_HEADER, 'Stream-Producer-Epoch')
		const seqStr = header(request, PRODUCER_SEQ_HEADER, 'Stream-Producer-Seq')
		const any = producerId !== undefined || epochStr !== undefined || seqStr !== undefined
		if (!any) return undefined
		if (producerId === undefined || epochStr === undefined || seqStr === undefined) {
			throw new ProtocolError(
				400,
				'All producer headers (Producer-Id, Producer-Epoch, Producer-Seq) must be provided together',
			)
		}
		if (producerId === '') throw new ProtocolError(400, 'Invalid Producer-Id: must not be empty')
		const epoch = parseStrictInteger(epochStr)
		if (epoch === undefined) throw new ProtocolError(400, 'Invalid Producer-Epoch: must be a non-negative integer')
		const seq = parseStrictInteger(seqStr)
		if (seq === undefined) throw new ProtocolError(400, 'Invalid Producer-Seq: must be a non-negative integer')
		return { producerId, epoch, seq }
	}

	private validateProducer(producer: ProducerHeaders): ProducerResult {
		const now = Date.now()
		this.sql.exec('DELETE FROM producers WHERE last_updated < ?', now - PRODUCER_STATE_TTL_MS)
		const state = this.sql
			.exec<{ epoch: number; last_seq: number }>(
				'SELECT epoch, last_seq FROM producers WHERE id = ?',
				producer.producerId,
			)
			.toArray()[0]
		const { producerId, epoch, seq } = producer
		if (!state) {
			if (seq !== 0) return { status: 'sequence_gap', expectedSeq: 0, receivedSeq: seq }
			return { status: 'accepted', producerId, epoch, seq }
		}
		const known: ProducerState = { epoch: state.epoch, lastSeq: state.last_seq }
		if (epoch < known.epoch) return { status: 'stale_epoch', currentEpoch: known.epoch }
		if (epoch > known.epoch) {
			if (seq !== 0) return { status: 'invalid_epoch_seq' }
			return { status: 'accepted', producerId, epoch, seq }
		}
		if (seq <= known.lastSeq) return { status: 'duplicate', lastSeq: known.lastSeq }
		if (seq === known.lastSeq + 1) return { status: 'accepted', producerId, epoch, seq }
		return { status: 'sequence_gap', expectedSeq: known.lastSeq + 1, receivedSeq: seq }
	}

	private commitProducer(result: ProducerResult): void {
		if (result.status !== 'accepted') return
		this.sql.exec(
			'INSERT OR REPLACE INTO producers (id, epoch, last_seq, last_updated) VALUES (?, ?, ?, ?)',
			result.producerId,
			result.epoch,
			result.seq,
			Date.now(),
		)
	}

	private producerFailure(result: ProducerResult, producer: ProducerHeaders): Response | undefined {
		switch (result.status) {
			case 'duplicate':
				return new Response(null, {
					status: 204,
					headers: {
						[PRODUCER_EPOCH_HEADER]: String(producer.epoch),
						[PRODUCER_SEQ_HEADER]: String(result.lastSeq),
					},
				})
			case 'stale_epoch':
				return textResponse(403, 'Stale producer epoch', {
					[PRODUCER_EPOCH_HEADER]: String(result.currentEpoch),
				})
			case 'invalid_epoch_seq':
				return textResponse(400, 'New epoch must start with sequence 0')
			case 'sequence_gap':
				return textResponse(409, 'Producer sequence gap', {
					[PRODUCER_EXPECTED_SEQ_HEADER]: String(result.expectedSeq),
					[PRODUCER_RECEIVED_SEQ_HEADER]: String(result.receivedSeq),
				})
			default:
				return undefined
		}
	}

	private closedConflict(meta: StreamMeta): Response {
		return textResponse(409, 'Stream is closed', {
			[STREAM_CLOSED_HEADER]: 'true',
			[STREAM_OFFSET_HEADER]: meta.currentOffset,
		})
	}

	private isClosingTuple(meta: StreamMeta, producer: ProducerHeaders | undefined): boolean {
		return (
			producer !== undefined &&
			meta.closedBy !== undefined &&
			meta.closedBy.producerId === producer.producerId &&
			meta.closedBy.epoch === producer.epoch &&
			meta.closedBy.seq === producer.seq
		)
	}

	private async handleAppend(request: Request): Promise<Response> {
		const contentType = request.headers.get('content-type')
		const streamSeq = header(request, STREAM_SEQ_HEADER)
		const closeStream = header(request, STREAM_CLOSED_HEADER) === 'true'
		const producer = this.parseProducerHeaders(request)
		const body = await this.readBody(request)

		// Everything below is synchronous: validation and commit are atomic.
		const meta = this.live()
		if (!meta) return textResponse(404, 'Stream not found')
		if (meta.softDeleted) return textResponse(410, 'Stream is gone')

		if (body.byteLength === 0 && closeStream) return this.handleCloseOnly(meta, producer)
		if (body.byteLength === 0) return textResponse(400, 'Empty body')
		if (!contentType) return textResponse(400, 'Content-Type header is required')

		if (meta.closed) {
			if (producer && this.isClosingTuple(meta, producer)) {
				return new Response(null, {
					status: 204,
					headers: {
						[STREAM_OFFSET_HEADER]: meta.currentOffset,
						[STREAM_CLOSED_HEADER]: 'true',
						[PRODUCER_EPOCH_HEADER]: String(producer.epoch),
						[PRODUCER_SEQ_HEADER]: String(producer.seq),
					},
				})
			}
			return this.closedConflict(meta)
		}

		if (normalizeContentType(contentType) !== normalizeContentType(meta.contentType)) {
			return textResponse(409, 'Content-type mismatch')
		}

		let producerResult: ProducerResult | undefined
		if (producer) {
			producerResult = this.validateProducer(producer)
			const failure = this.producerFailure(producerResult, producer)
			if (failure) return failure
		}

		if (streamSeq !== undefined && meta.lastSeq !== undefined && streamSeq <= meta.lastSeq) {
			return textResponse(409, 'Sequence conflict')
		}

		const processed = this.prepareData(meta, body, false)
		if (!processed) return textResponse(400, 'Empty body')

		let offset = ''
		const next: StreamMeta = { ...meta }
		this.ctx.storage.transactionSync(() => {
			offset = this.appendRow(next, processed)
			if (producerResult) this.commitProducer(producerResult)
			if (streamSeq !== undefined) next.lastSeq = streamSeq
			if (closeStream) {
				next.closed = true
				if (producer)
					next.closedBy = { producerId: producer.producerId, epoch: producer.epoch, seq: producer.seq }
			}
			next.lastAccessedAt = Date.now()
			this.saveMeta(next)
		})
		this.notify()

		const headers: Record<string, string> = { [STREAM_OFFSET_HEADER]: offset }
		if (producer) {
			headers[PRODUCER_EPOCH_HEADER] = String(producer.epoch)
			headers[PRODUCER_SEQ_HEADER] = String(producer.seq)
		}
		if (closeStream) headers[STREAM_CLOSED_HEADER] = 'true'
		return new Response(null, { status: producer ? 200 : 204, headers })
	}

	private handleCloseOnly(meta: StreamMeta, producer: ProducerHeaders | undefined): Response {
		if (producer) {
			if (meta.closed) {
				if (this.isClosingTuple(meta, producer)) {
					return new Response(null, {
						status: 204,
						headers: {
							[STREAM_OFFSET_HEADER]: meta.currentOffset,
							[STREAM_CLOSED_HEADER]: 'true',
							[PRODUCER_EPOCH_HEADER]: String(producer.epoch),
							[PRODUCER_SEQ_HEADER]: String(producer.seq),
						},
					})
				}
				return this.closedConflict(meta)
			}
			const result = this.validateProducer(producer)
			const failure = this.producerFailure(result, producer)
			if (failure) {
				if (result.status === 'duplicate') {
					return new Response(null, {
						status: 204,
						headers: {
							[STREAM_OFFSET_HEADER]: meta.currentOffset,
							[STREAM_CLOSED_HEADER]: 'true',
							[PRODUCER_EPOCH_HEADER]: String(producer.epoch),
							[PRODUCER_SEQ_HEADER]: String(result.lastSeq),
						},
					})
				}
				return failure
			}
			this.ctx.storage.transactionSync(() => {
				this.commitProducer(result)
				meta.closed = true
				meta.closedBy = { producerId: producer.producerId, epoch: producer.epoch, seq: producer.seq }
				meta.lastAccessedAt = Date.now()
				this.saveMeta(meta)
			})
			this.notify()
			return new Response(null, {
				status: 204,
				headers: {
					[STREAM_OFFSET_HEADER]: meta.currentOffset,
					[STREAM_CLOSED_HEADER]: 'true',
					[PRODUCER_EPOCH_HEADER]: String(producer.epoch),
					[PRODUCER_SEQ_HEADER]: String(producer.seq),
				},
			})
		}
		meta.closed = true
		meta.lastAccessedAt = Date.now()
		this.saveMeta(meta)
		this.notify()
		return new Response(null, {
			status: 204,
			headers: { [STREAM_OFFSET_HEADER]: meta.currentOffset, [STREAM_CLOSED_HEADER]: 'true' },
		})
	}

	// ==========================================================================
	// DELETE
	// ==========================================================================

	private async handleDelete(): Promise<Response> {
		const meta = this.live()
		if (!meta) return textResponse(404, 'Stream not found')
		if (meta.softDeleted) return textResponse(410, 'Stream is gone')
		if (meta.refCount > 0) {
			meta.softDeleted = true
			this.saveMeta(meta)
			this.notify()
			return new Response(null, { status: 204 })
		}
		const source = this.purge()
		await this.releaseSource(source)
		return new Response(null, { status: 204 })
	}

	// ==========================================================================
	// TTL alarm
	// ==========================================================================

	override async alarm(): Promise<void> {
		const meta = this.meta
		if (!meta || meta.softDeleted) return
		const expiry = this.expiryTime(meta)
		if (expiry === undefined) return
		if (Date.now() >= expiry) {
			if (meta.refCount > 0) {
				meta.softDeleted = true
				this.saveMeta(meta)
				return
			}
			await this.releaseSource(this.purge())
			return
		}
		await this.ctx.storage.setAlarm(expiry)
	}
}

function abortPromise(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal) return
		if (signal.aborted) {
			resolve()
			return
		}
		signal.addEventListener('abort', () => resolve(), { once: true })
	})
}
