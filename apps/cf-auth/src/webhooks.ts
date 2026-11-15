import type { MembershipRow } from './db'
import { serializeMembership } from './db'
import type { Env } from './env'
import { newId } from './util'

export type MembershipEvent =
	| 'organization_membership.created'
	| 'organization_membership.updated'
	| 'organization_membership.deleted'

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
	return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** WorkOS signature header: `t=<ms>, v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export async function signWebhook(secret: string, body: string, timestamp = Date.now()): Promise<string> {
	return `t=${timestamp}, v1=${await hmacHex(secret, `${timestamp}.${body}`)}`
}

/**
 * Delivers an organization_membership.* event to WEBHOOK_URL if both it and WEBHOOK_SECRET are set.
 * Best effort (one attempt, in waitUntil); the API's own membership writes already run seat sync,
 * so a missed delivery only skips the access-request backfill the API does on `.created`.
 */
export function emitMembershipEvent(
	env: Env,
	ctx: ExecutionContext,
	event: MembershipEvent,
	membership: MembershipRow,
): void {
	if (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET) return
	const url = env.WEBHOOK_URL
	const secret = env.WEBHOOK_SECRET
	const body = JSON.stringify({
		id: newId('event'),
		event,
		data: serializeMembership(membership),
		created_at: new Date().toISOString(),
	})
	ctx.waitUntil(
		(async () => {
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'workos-signature': await signWebhook(secret, body),
					},
					body,
				})
				if (!res.ok) console.warn(`webhook delivery for ${event} returned ${res.status}`)
			} catch (error) {
				console.warn(
					`webhook delivery for ${event} failed: ${error instanceof Error ? error.message : 'unknown'}`,
				)
			}
		})(),
	)
}
