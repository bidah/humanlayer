import { sql } from 'drizzle-orm'
import { bigint, check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { createSelectSchema } from 'drizzle-zod'
import z from 'zod/v4'

import { organizations } from './organizations'

/** Sandbox providers the cloud host provisioner (apps/cf-hosts) supports. */
export const CloudHostProviderSchema = z.enum(['cloudflare', 'daytona', 'e2b'])
export type CloudHostProvider = z.infer<typeof CloudHostProviderSchema>

/**
 * Lifecycle of a cloud host. See `utils/cloud-host-lifecycle.ts` for the transitions and where
 * each one happens.
 *
 * provisioning → bootstrapping → ready
 *      ↓              ↓            ↓
 *    failed ←─────────┘            │
 *      ↓                           ↓
 *  destroying ──────────────→ destroyed
 */
export const CloudHostStatusSchema = z.enum([
	'provisioning',
	'bootstrapping',
	'ready',
	'failed',
	'destroying',
	'destroyed',
])
export type CloudHostStatus = z.infer<typeof CloudHostStatusSchema>

export const CloudHostSizeSchema = z.enum(['small', 'medium', 'large'])
export type CloudHostSize = z.infer<typeof CloudHostSizeSchema>

const epochNow = sql`(extract(epoch from now()) * 1000)::bigint`

/**
 * A daemon host the API provisioned in a cloud sandbox for one user in one organization.
 *
 * There is deliberately no foreign key to `online_hosts`: the stale-daemon sweeper deletes those
 * rows, while this row must outlive them, because it is what revokes the host's daemon token
 * (`revoked_at`). Agent credentials passed at creation are never stored here.
 */
export const cloudHosts = pgTable(
	'cloud_hosts',
	{
		organization_id: uuid('organization_id')
			.references(() => organizations.id, { onDelete: 'cascade' })
			.notNull(),
		user_id: text('user_id').notNull(),
		/** The daemon's host id: the `hostId` claim of its daemon token and `online_hosts.host_id`. */
		host_id: text('host_id').notNull(),
		provider: text('provider').$type<CloudHostProvider>().notNull(),
		/** Provider-native sandbox id, once the provisioner reported it. */
		sandbox_id: text('sandbox_id'),
		status: text('status').$type<CloudHostStatus>().notNull().default('provisioning'),
		/** Why the host failed, or why it was destroyed without being asked to (expired, gone). */
		error: text('error'),
		size: text('size').$type<CloudHostSize>(),
		ttl_minutes: integer('ttl_minutes').notNull(),
		/** When the provisioner destroys the sandbox on its own. */
		expires_at: bigint('expires_at', { mode: 'bigint' }),
		created_at: bigint('created_at', { mode: 'bigint' })
			.notNull()
			.default(epochNow)
			.$defaultFn(() => BigInt(Date.now())),
		updated_at: bigint('updated_at', { mode: 'bigint' })
			.notNull()
			.default(epochNow)
			.$defaultFn(() => BigInt(Date.now()))
			.$onUpdateFn(() => BigInt(Date.now())),
		/** First accepted daemon heartbeat. */
		ready_at: bigint('ready_at', { mode: 'bigint' }),
		destroyed_at: bigint('destroyed_at', { mode: 'bigint' }),
		/** Set once, when destruction starts; from then on the host's daemon token is rejected. */
		revoked_at: bigint('revoked_at', { mode: 'bigint' }),
	},
	(t) => [
		// The daemon-token revocation check looks a host up by exactly these three claims.
		primaryKey({ name: 'cloud_hosts_pk', columns: [t.organization_id, t.user_id, t.host_id] }),
		check('cloud_hosts_provider_check', sql`${t.provider} in ('cloudflare', 'daytona', 'e2b')`),
		check(
			'cloud_hosts_status_check',
			sql`${t.status} in ('provisioning', 'bootstrapping', 'ready', 'failed', 'destroying', 'destroyed')`,
		),
		check('cloud_hosts_size_check', sql`${t.size} is null or ${t.size} in ('small', 'medium', 'large')`),
		// The cross-organization reconcile pass (apps/cf-jobs) scans only hosts not yet destroyed.
		index('cloud_hosts_unsettled_created_at_idx')
			.on(t.created_at)
			.where(sql`${t.status} <> 'destroyed'`),
	],
)

export const cloudHostSelectSchema = createSelectSchema(cloudHosts, {
	provider: CloudHostProviderSchema,
	status: CloudHostStatusSchema,
	size: CloudHostSizeSchema.nullable(),
})
export type CloudHost = typeof cloudHosts.$inferSelect
export type NewCloudHost = typeof cloudHosts.$inferInsert
