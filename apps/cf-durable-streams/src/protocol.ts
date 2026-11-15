/**
 * Wire-level helpers for the Durable Streams HTTP protocol.
 *
 * Behaviour mirrors the reference JS server (`@durable-streams/server` 0.3.9)
 * so that `@durable-streams/client` / `@durable-streams/state` work unmodified.
 */

export const STREAM_OFFSET_HEADER = 'Stream-Next-Offset'
export const STREAM_CURSOR_HEADER = 'Stream-Cursor'
export const STREAM_UP_TO_DATE_HEADER = 'Stream-Up-To-Date'
export const STREAM_CLOSED_HEADER = 'Stream-Closed'
export const STREAM_SEQ_HEADER = 'Stream-Seq'
export const STREAM_TTL_HEADER = 'Stream-TTL'
export const STREAM_EXPIRES_AT_HEADER = 'Stream-Expires-At'
export const STREAM_SSE_DATA_ENCODING_HEADER = 'Stream-SSE-Data-Encoding'
export const STREAM_FORKED_FROM_HEADER = 'Stream-Forked-From'
export const STREAM_FORK_OFFSET_HEADER = 'Stream-Fork-Offset'
export const STREAM_FORK_SUB_OFFSET_HEADER = 'Stream-Fork-Sub-Offset'
export const PRODUCER_ID_HEADER = 'Producer-Id'
export const PRODUCER_EPOCH_HEADER = 'Producer-Epoch'
export const PRODUCER_SEQ_HEADER = 'Producer-Seq'
export const PRODUCER_EXPECTED_SEQ_HEADER = 'Producer-Expected-Seq'
export const PRODUCER_RECEIVED_SEQ_HEADER = 'Producer-Received-Seq'

export const ZERO_OFFSET = '0000000000000000_0000000000000000'

/** Per-message framing overhead used by the reference offset arithmetic. */
const FRAME_OVERHEAD = 5

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const encodeText = (text: string): Uint8Array => textEncoder.encode(text)
export const decodeText = (bytes: Uint8Array): string => textDecoder.decode(bytes)

export function formatOffset(readSeq: number, byteOffset: number): string {
	return `${String(readSeq).padStart(16, '0')}_${String(byteOffset).padStart(16, '0')}`
}

/** Offset after appending `length` bytes at `current` (reference arithmetic). */
export function advanceOffset(current: string, length: number): string {
	const [readSeq, byteOffset] = current.split('_').map(Number) as [number, number]
	return formatOffset(readSeq, byteOffset + FRAME_OVERHEAD + length)
}

export const VALID_READ_OFFSET = /^(-1|now|\d+_\d+)$/
export const VALID_FORK_OFFSET = /^\d+_\d+$/
const TTL_PATTERN = /^(0|[1-9]\d*)$/
const STRICT_INTEGER = /^\d+$/

export function parseTtl(value: string): number | undefined {
	if (!TTL_PATTERN.test(value)) return undefined
	const ttl = Number.parseInt(value, 10)
	return Number.isSafeInteger(ttl) && ttl >= 0 ? ttl : undefined
}

export function parseStrictInteger(value: string): number | undefined {
	if (!STRICT_INTEGER.test(value)) return undefined
	const n = Number(value)
	return Number.isSafeInteger(n) ? n : undefined
}

export function normalizeContentType(contentType: string | undefined | null): string {
	if (!contentType) return ''
	return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

export const isJsonContentType = (contentType: string | undefined | null): boolean =>
	normalizeContentType(contentType) === 'application/json'

/** SSE payloads are base64 encoded unless the stream is text/* or application/json. */
export function needsBase64(contentType: string | undefined | null): boolean {
	const ct = normalizeContentType(contentType)
	return !(ct.startsWith('text/') || ct === 'application/json')
}

export class ProtocolError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message)
	}
}

/**
 * Validate and normalise a JSON append body. Arrays are flattened one level;
 * each element is stored as `elem,` so fragments concatenate cleanly.
 * Returns an empty array for `[]` on create.
 */
export function processJsonAppend(data: Uint8Array, isInitialCreate: boolean): Uint8Array {
	let parsed: unknown
	try {
		parsed = JSON.parse(decodeText(data))
	} catch {
		throw new ProtocolError(400, 'Invalid JSON')
	}
	if (Array.isArray(parsed)) {
		if (parsed.length === 0) {
			if (isInitialCreate) return new Uint8Array(0)
			throw new ProtocolError(400, 'Empty arrays are not allowed')
		}
		return encodeText(`${parsed.map((item) => JSON.stringify(item)).join(',')},`)
	}
	return encodeText(`${JSON.stringify(parsed)},`)
}

/** Parse a stored JSON fragment (`a,b,`) into its values. */
export function parseJsonFragment(data: Uint8Array): Array<unknown> {
	let text = decodeText(data).trimEnd()
	if (text.endsWith(',')) text = text.slice(0, -1)
	return JSON.parse(`[${text}]`) as Array<unknown>
}

/**
 * State-protocol change/control events get `headers.offset` set to the offset
 * of the message that carried them (consumed by `@durable-streams/state`).
 */
function enrichJsonValueWithOffset(value: unknown, offset: string): string {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value)
	const candidate = value as { headers?: Record<string, unknown> }
	const headers = candidate.headers
	if (!headers || typeof headers !== 'object') return JSON.stringify(value)
	const isStateChange = typeof headers.operation === 'string'
	const isStateControl = typeof headers.control === 'string'
	if (!isStateChange && !isStateControl) return JSON.stringify(value)
	return JSON.stringify({ ...candidate, headers: { ...headers, offset } })
}

export interface StoredMessage {
	offset: string
	data: Uint8Array
}

export function formatJsonMessages(messages: ReadonlyArray<StoredMessage>): string {
	if (messages.length === 0) return '[]'
	const items: Array<string> = []
	for (const message of messages) {
		for (const value of parseJsonFragment(message.data)) {
			items.push(enrichJsonValueWithOffset(value, message.offset))
		}
	}
	return `[${items.join(',')}]`
}

export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
	let total = 0
	for (const part of parts) total += part.byteLength
	const out = new Uint8Array(total)
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.byteLength
	}
	return out
}

/** Base64 encode without Node's Buffer; chunk size is a multiple of 3. */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 3 * 8192
	const parts: Array<string> = []
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const slice = bytes.subarray(i, i + CHUNK)
		let binary = ''
		for (let j = 0; j < slice.length; j += 4096) {
			binary += String.fromCharCode(...slice.subarray(j, j + 4096))
		}
		parts.push(btoa(binary))
	}
	return parts.join('')
}

export function utf8ToBase64(text: string): string {
	return bytesToBase64(encodeText(text))
}

/**
 * Encode a payload as SSE `data:` lines. Every line terminator (CRLF, CR, LF)
 * starts a new `data:` line so payloads cannot inject event boundaries. No
 * space after the colon: clients strip exactly one leading space.
 */
export function encodeSSEData(payload: string): string {
	return `${payload
		.split(/\r\n|\r|\n/)
		.map((line) => `data:${line}`)
		.join('\n')}\n\n`
}

export function sseEvent(type: 'data' | 'control', payload: string): string {
	return `event: ${type}\n${encodeSSEData(payload)}`
}

// Cursor generation (Protocol Section 8.1), identical to the reference server.
const CURSOR_EPOCH_MS = Date.parse('2024-10-09T00:00:00.000Z')
const CURSOR_INTERVAL_SECONDS = 20
const MAX_JITTER_SECONDS = 3600
const MIN_JITTER_SECONDS = 1

function currentCursorInterval(): number {
	return Math.floor((Date.now() - CURSOR_EPOCH_MS) / (CURSOR_INTERVAL_SECONDS * 1000))
}

export function generateResponseCursor(clientCursor: string | undefined | null): string {
	const current = currentCursorInterval()
	if (!clientCursor) return String(current)
	const client = Number.parseInt(clientCursor, 10)
	if (Number.isNaN(client) || client < current) return String(current)
	const jitterSeconds = MIN_JITTER_SECONDS + Math.floor(Math.random() * (MAX_JITTER_SECONDS - MIN_JITTER_SECONDS + 1))
	return String(client + Math.max(1, Math.ceil(jitterSeconds / CURSOR_INTERVAL_SECONDS)))
}

export function etagFor(path: string, startOffset: string, endOffset: string, closed: boolean): string {
	return `"${utf8ToBase64(path)}:${startOffset}:${endOffset}${closed ? ':c' : ''}"`
}

export function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}
