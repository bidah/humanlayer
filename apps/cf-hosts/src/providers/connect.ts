/**
 * Minimal Connect-protocol (connectrpc.com/docs/protocol) client for server-streaming calls with
 * JSON codec, enough to drive E2B envd's `process.Process/Start` with plain fetch.
 *
 * Envelope: 1 byte flags | 4 byte big-endian length | payload. Flag 0x02 marks the end-of-stream
 * message, whose JSON may carry `{error: {code, message}}`.
 */
import type { FetchLike } from './types'

export function encodeEnvelope(message: unknown, flags = 0): Uint8Array {
	const payload = new TextEncoder().encode(JSON.stringify(message))
	const out = new Uint8Array(5 + payload.length)
	out[0] = flags
	new DataView(out.buffer).setUint32(1, payload.length, false)
	out.set(payload, 5)
	return out
}

export interface DecodedEnvelope {
	flags: number
	json: unknown
}

export function decodeEnvelopes(bytes: Uint8Array): DecodedEnvelope[] {
	const out: DecodedEnvelope[] = []
	let off = 0
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	while (off + 5 <= bytes.length) {
		const flags = bytes[off] ?? 0
		const len = dv.getUint32(off + 1, false)
		const start = off + 5
		if (start + len > bytes.length) throw new Error('truncated Connect envelope')
		const text = new TextDecoder().decode(bytes.subarray(start, start + len))
		out.push({ flags, json: text.length ? JSON.parse(text) : {} })
		off = start + len
	}
	return out
}

export class ConnectError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`)
		this.name = 'ConnectError'
	}
}

/**
 * Perform a server-streaming call and buffer every message until the stream ends.
 * Only suitable for short-lived streams (we only start detached commands).
 */
export async function connectServerStream(
	f: FetchLike,
	url: string,
	request: unknown,
	headers: HeadersInit,
	timeoutMs: number,
): Promise<unknown[]> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), timeoutMs)
	const h = new Headers(headers)
	h.set('content-type', 'application/connect+json')
	h.set('connect-protocol-version', '1')
	h.set('connect-timeout-ms', String(timeoutMs))
	try {
		const res = await f(url, {
			method: 'POST',
			headers: h,
			body: encodeEnvelope(request),
			signal: ctrl.signal,
		})
		const buf = new Uint8Array(await res.arrayBuffer())
		if (!res.ok) {
			let msg = new TextDecoder().decode(buf).slice(0, 300)
			try {
				const j = JSON.parse(msg) as { code?: string; message?: string }
				msg = j.message ?? msg
				throw new ConnectError(j.code ?? `http_${res.status}`, msg)
			} catch (e) {
				if (e instanceof ConnectError) throw e
				throw new ConnectError(`http_${res.status}`, msg)
			}
		}
		const messages: unknown[] = []
		for (const env of decodeEnvelopes(buf)) {
			if (env.flags & 0x02) {
				const end = env.json as { error?: { code?: string; message?: string } }
				if (end.error) throw new ConnectError(end.error.code ?? 'unknown', end.error.message ?? '')
				continue
			}
			messages.push(env.json)
		}
		return messages
	} finally {
		clearTimeout(timer)
	}
}
