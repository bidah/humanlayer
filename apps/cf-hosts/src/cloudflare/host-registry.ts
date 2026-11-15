import { DurableObject } from 'cloudflare:workers'

export interface RegistryEntry {
	hostId: string
	createdAt: string
	expiresAt: string
}

/**
 * Durable Objects cannot be enumerated, so `GET /v1/hosts?provider=cloudflare` needs an index of
 * live Cloudflare hosts. This single global object is that index: no ownership, no secrets.
 */
export class HostRegistry extends DurableObject {
	async add(hostId: string, v: { createdAt: string; expiresAt: string }): Promise<void> {
		await this.ctx.storage.put(`host:${hostId}`, { hostId, ...v } satisfies RegistryEntry)
	}

	async remove(hostId: string): Promise<void> {
		await this.ctx.storage.delete(`host:${hostId}`)
	}

	async list(): Promise<RegistryEntry[]> {
		const m = await this.ctx.storage.list<RegistryEntry>({ prefix: 'host:' })
		return [...m.values()]
	}
}
