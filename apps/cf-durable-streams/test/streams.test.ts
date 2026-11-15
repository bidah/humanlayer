import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { DurableStream, IdempotentProducer, stream } from '@durable-streams/client'
import { describe, expect, inject, it } from 'vitest'

const EMPTY = '0000000000000000_0000000000000000'
const MiB = 1024 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const streamUrl = (name: string) => `${inject('baseUrl')}/v1/stream/test/${name}/${randomUUID()}`
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function create(url: string, headers: Record<string, string>, body?: BodyInit) {
	const res = await fetch(url, { method: 'PUT', headers, body })
	expect([200, 201]).toContain(res.status)
	return res
}

interface SseEvent {
	type: string
	data: string
}

/** Read raw SSE until `until` returns true, the server ends the response, or timeout. */
async function readSse(url: string, until: (events: Array<SseEvent>) => boolean, timeoutMs = 10_000) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	const res = await fetch(url, { signal: controller.signal })
	const events: Array<SseEvent> = []
	let ended = false
	let buffer = ''
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) {
				ended = true
				break
			}
			buffer += decoder.decode(value, { stream: true })
			let idx: number
			while ((idx = buffer.indexOf('\n\n')) >= 0) {
				const block = buffer.slice(0, idx)
				buffer = buffer.slice(idx + 2)
				const lines = block.split('\n')
				const type =
					lines
						.find((l) => l.startsWith('event:'))
						?.slice(6)
						.trim() ?? ''
				const data = lines
					.filter((l) => l.startsWith('data:'))
					.map((l) => l.slice(5))
					.join('\n')
				events.push({ type, data })
			}
			if (until(events)) break
		}
	} catch (err) {
		if (!(err instanceof Error && err.name === 'AbortError')) throw err
	} finally {
		clearTimeout(timer)
		controller.abort()
	}
	return { res, events, ended }
}

const controls = (events: Array<SseEvent>) =>
	events
		.filter((e) => e.type === 'control')
		.map((e) => JSON.parse(e.data) as { streamNextOffset: string; upToDate?: boolean; streamCursor?: string })

describe('service surface', () => {
	it('answers health checks and rejects paths outside /v1/stream/', async () => {
		const base = inject('baseUrl')
		expect((await fetch(`${base}/healthz`)).status).toBe(200)
		expect((await fetch(`${base}/readyz`)).status).toBe(200)
		expect((await fetch(`${base}/other/thing`, { method: 'PUT' })).status).toBe(404)
	})

	it('exposes the protocol headers via CORS', async () => {
		const url = streamUrl('cors')
		const res = await create(url, { 'content-type': 'application/json' })
		const exposed = res.headers.get('access-control-expose-headers') ?? ''
		for (const name of [
			'stream-next-offset',
			'stream-up-to-date',
			'stream-cursor',
			'stream-sse-data-encoding',
			'producer-epoch',
			'producer-seq',
		]) {
			expect(exposed.toLowerCase()).toContain(name)
		}
	})
})

describe('create / HEAD', () => {
	it('creates idempotently with the same config and conflicts on a different one', async () => {
		const url = streamUrl('create')
		const first = await fetch(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'stream-ttl': '3600' },
		})
		expect(first.status).toBe(201)
		expect(first.headers.get('stream-next-offset')).toBe(EMPTY)
		const again = await fetch(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'stream-ttl': '3600' },
		})
		expect(again.status).toBe(200)
		const different = await fetch(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/octet-stream', 'stream-ttl': '3600' },
		})
		expect(different.status).toBe(409)
		const head = await fetch(url, { method: 'HEAD' })
		expect(head.status).toBe(200)
		expect(head.headers.get('stream-next-offset')).toBe(EMPTY)
		expect(head.headers.get('stream-ttl')).toBe('3600')
	})

	it('accepts Stream-Expires-At', async () => {
		const url = streamUrl('expires-at')
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'stream-expires-at': expiresAt },
		})
		expect(res.status).toBe(201)
		const head = await fetch(url, { method: 'HEAD' })
		expect(head.headers.get('stream-expires-at')).toBe(expiresAt)
	})

	it('returns 404 for missing streams and after DELETE', async () => {
		const url = streamUrl('delete')
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(404)
		await create(url, { 'content-type': 'application/json' })
		expect((await fetch(url, { method: 'DELETE' })).status).toBe(204)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(404)
		expect((await fetch(`${url}?offset=-1`)).status).toBe(404)
		expect((await fetch(url, { method: 'DELETE' })).status).toBe(404)
	})
})

describe('sliding idle TTL', () => {
	it('expires an idle stream and HEAD does not renew it', async () => {
		const url = streamUrl('ttl-head')
		await create(url, { 'content-type': 'application/json', 'stream-ttl': '2' })
		await sleep(1_200)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(200)
		await sleep(1_200)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(404)
		expect((await fetch(`${url}?offset=-1`)).status).toBe(404)
		expect(
			(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status,
		).toBe(404)
	})

	it('renews on GET and POST', async () => {
		const url = streamUrl('ttl-renew')
		await create(url, { 'content-type': 'application/json', 'stream-ttl': '2' })
		await sleep(1_200)
		expect((await fetch(`${url}?offset=-1`)).status).toBe(200)
		await sleep(1_200)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(200)
		const post = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })
		expect(post.status).toBe(204)
		await sleep(1_200)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(200)
		await sleep(1_500)
		expect((await fetch(url, { method: 'HEAD' })).status).toBe(404)
	})

	it('recreates a fresh stream at the same path after expiry', async () => {
		const url = streamUrl('ttl-recreate')
		await create(url, { 'content-type': 'application/json', 'stream-ttl': '1' }, '[{"old":true}]')
		await sleep(1_300)
		const res = await fetch(url, {
			method: 'PUT',
			headers: { 'content-type': 'application/json', 'stream-ttl': '1' },
		})
		expect(res.status).toBe(201)
		expect(res.headers.get('stream-next-offset')).toBe(EMPTY)
		expect(await (await fetch(`${url}?offset=-1`)).json()).toEqual([])
	})
})

describe('large bodies (chunked across SQLite rows)', () => {
	it('round-trips an 8 MiB binary append byte-exactly', async () => {
		const url = streamUrl('large-binary')
		await create(url, { 'content-type': 'application/octet-stream' })
		const payload = new Uint8Array(randomBytes(8 * MiB))
		const post = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: payload,
		})
		expect(post.status).toBe(204)
		const read = await fetch(`${url}?offset=-1`)
		expect(read.status).toBe(200)
		expect(read.headers.get('stream-up-to-date')).toBe('true')
		const body = new Uint8Array(await read.arrayBuffer())
		expect(body.byteLength).toBe(payload.byteLength)
		expect(sha(body)).toBe(sha(payload))
	})

	it('round-trips a large JSON message and paginates catch-up', async () => {
		const url = streamUrl('large-json')
		await create(url, { 'content-type': 'application/json' })
		const big = 'x'.repeat(3 * MiB)
		for (let i = 0; i < 3; i++) {
			const post = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify([{ i, big }]),
			})
			expect(post.status).toBe(204)
		}
		const items: Array<{ i: number; big: string }> = []
		let offset = '-1'
		let pages = 0
		for (;;) {
			const res = await fetch(`${url}?offset=${offset}`)
			expect(res.status).toBe(200)
			items.push(...((await res.json()) as typeof items))
			pages++
			offset = res.headers.get('stream-next-offset')!
			if (res.headers.get('stream-up-to-date') === 'true') break
		}
		expect(pages).toBeGreaterThan(1)
		expect(items.map((x) => x.i)).toEqual([0, 1, 2])
		expect(items.every((x) => x.big === big)).toBe(true)
	})

	it('rejects appends that would exceed the per-stream cap with 413', async () => {
		// global-setup lowers MAX_STREAM_BYTES to 32 MiB (production default: 100 MiB).
		const url = streamUrl('stream-cap')
		await create(url, { 'content-type': 'application/octet-stream' })
		const append = () =>
			fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: new Uint8Array(12 * MiB),
			})
		expect((await append()).status).toBe(204)
		expect((await append()).status).toBe(204)
		expect((await append()).status).toBe(413)
		const head = await fetch(url, { method: 'HEAD' })
		expect(head.status).toBe(200)
	})

	it('rejects appends above the per-request limit with 413', async () => {
		const url = streamUrl('too-large')
		await create(url, { 'content-type': 'application/octet-stream' })
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: new Uint8Array(17 * MiB),
		})
		expect(res.status).toBe(413)
	})
})

describe('JSON streams', () => {
	it('flattens batches and re-concatenates to one array', async () => {
		const url = streamUrl('json-batch')
		await create(url, { 'content-type': 'application/json' })
		await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '[{"a":1},{"b":2},{"c":3}]',
		})
		await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"d":4}' })
		const res = await fetch(`${url}?offset=-1`)
		expect(await res.json()).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }])
		const empty = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })
		expect(empty.status).toBe(400)
	})

	it('stamps headers.offset on state-protocol events', async () => {
		const url = streamUrl('json-state')
		await create(url, { 'content-type': 'application/json' })
		const post = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify([{ type: 'row', key: 'k', value: { v: 1 }, headers: { operation: 'insert' } }]),
		})
		const offset = post.headers.get('stream-next-offset')
		const [event] = (await (await fetch(`${url}?offset=-1`)).json()) as Array<{ headers: { offset: string } }>
		expect(event!.headers.offset).toBe(offset)
	})
})

describe('idempotent producers', () => {
	const post = (url: string, headers: Record<string, string>, body: string) =>
		fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

	it('dedupes, fences stale epochs, rejects gaps and resets seq on a new epoch', async () => {
		const url = streamUrl('producer')
		await create(url, { 'content-type': 'application/json' })
		const p = (epoch: number, seq: number) => ({
			'producer-id': 'p1',
			'producer-epoch': String(epoch),
			'producer-seq': String(seq),
		})
		expect((await post(url, p(0, 0), '[1]')).status).toBe(200)
		expect((await post(url, p(0, 1), '[2]')).status).toBe(200)
		const dup = await post(url, p(0, 1), '[2]')
		expect(dup.status).toBe(204)
		expect(dup.headers.get('producer-seq')).toBe('1')
		const gap = await post(url, p(0, 5), '[9]')
		expect(gap.status).toBe(409)
		expect(gap.headers.get('producer-expected-seq')).toBe('2')
		expect((await post(url, p(1, 0), '[3]')).status).toBe(200)
		const stale = await post(url, p(0, 2), '[9]')
		expect(stale.status).toBe(403)
		expect(stale.headers.get('producer-epoch')).toBe('1')
		expect((await post(url, p(1, 1), '[4]')).status).toBe(200)
		expect(await (await fetch(`${url}?offset=-1`)).json()).toEqual([1, 2, 3, 4])
	})

	it('accepts Stream-Producer-* header aliases', async () => {
		const url = streamUrl('producer-alias')
		await create(url, { 'content-type': 'application/octet-stream' })
		const h = (seq: number) => ({
			'content-type': 'application/octet-stream',
			'stream-producer-id': 'yjs',
			'stream-producer-epoch': '0',
			'stream-producer-seq': String(seq),
		})
		expect((await fetch(url, { method: 'POST', headers: h(0), body: 'a' })).status).toBe(200)
		expect((await fetch(url, { method: 'POST', headers: h(0), body: 'a' })).status).toBe(204)
		expect((await fetch(url, { method: 'POST', headers: h(1), body: 'b' })).status).toBe(200)
		expect(await (await fetch(`${url}?offset=-1`)).text()).toBe('ab')
	})
})

describe('SSE', () => {
	it('resumes from the last control offset without duplicates', async () => {
		const url = streamUrl('sse-resume')
		await create(url, { 'content-type': 'application/json' }, '[{"n":1}]')
		const first = await readSse(`${url}?offset=-1&live=sse`, (ev) => controls(ev).some((c) => c.upToDate))
		expect(first.res.headers.get('content-type')).toBe('text/event-stream')
		const data = first.events.filter((e) => e.type === 'data').flatMap((e) => JSON.parse(e.data))
		expect(data).toEqual([{ n: 1 }])
		const last = controls(first.events).at(-1)!
		await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[{"n":2}]' })
		const second = await readSse(`${url}?offset=${last.streamNextOffset}&live=sse`, (ev) =>
			ev.some((e) => e.type === 'data'),
		)
		const more = second.events.filter((e) => e.type === 'data').flatMap((e) => JSON.parse(e.data))
		expect(more).toEqual([{ n: 2 }])
	})

	it('wakes live subscribers on append', async () => {
		const url = streamUrl('sse-live')
		await create(url, { 'content-type': 'application/json' })
		const reading = readSse(`${url}?offset=now&live=sse`, (ev) => ev.some((e) => e.type === 'data'))
		await sleep(300)
		await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[{"live":true}]' })
		const { events } = await reading
		expect(events.filter((e) => e.type === 'data').flatMap((e) => JSON.parse(e.data))).toEqual([{ live: true }])
	})

	it('base64-encodes binary streams and announces it', async () => {
		const url = streamUrl('sse-binary')
		const payload = new Uint8Array([0, 1, 2, 10, 13, 255, 254])
		await create(url, { 'content-type': 'application/octet-stream' }, payload)
		const { res, events } = await readSse(`${url}?offset=-1&live=sse`, (ev) => controls(ev).some((c) => c.upToDate))
		expect(res.headers.get('stream-sse-data-encoding')).toBe('base64')
		const encoded = events.find((e) => e.type === 'data')!.data
		expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(payload)
	})

	it('closes the response periodically', async () => {
		const url = streamUrl('sse-close')
		await create(url, { 'content-type': 'application/json' })
		const started = Date.now()
		const { ended } = await readSse(`${url}?offset=-1&live=sse`, () => false, 10_000)
		expect(ended).toBe(true)
		expect(Date.now() - started).toBeLessThan(8_000)
	})
})

describe('@durable-streams/client end to end', () => {
	it('create -> IdempotentProducer append -> live SSE read across server-side reconnects', async () => {
		const url = streamUrl('client')
		const handle = await DurableStream.create({ url, contentType: 'application/json', ttlSeconds: 60 })
		const producer = new IdempotentProducer(handle, `producer-${randomUUID()}`, { epoch: 0, lingerMs: 5 })
		producer.append(JSON.stringify({ n: 1 }))
		producer.append(JSON.stringify({ n: 2 }))
		await producer.flush()

		const res = await stream<{ n: number }>({ url, offset: '-1', live: 'sse' })
		const received: Array<number> = []
		const done = new Promise<void>((resolve) => {
			res.subscribeJson(async (batch) => {
				for (const item of batch.items) received.push(item.n)
				if (received.length >= 4) resolve()
			})
		})
		await sleep(500)
		producer.append(JSON.stringify({ n: 3 }))
		await producer.flush()
		// Outlive SSE_MAX_DURATION_MS so the client must reconnect from its offset.
		await sleep(3_000)
		producer.append(JSON.stringify({ n: 4 }))
		await producer.flush()
		await done
		res.cancel()
		await producer.detach()
		expect(received).toEqual([1, 2, 3, 4])
	})
})
