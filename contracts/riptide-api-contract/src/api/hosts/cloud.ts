import { CloudHostProviderSchema, CloudHostSizeSchema, CloudHostStatusSchema } from '@humanlayer/db/tables/cloud-hosts'
import z from 'zod/v4'

import { contractBuilder } from '../../contract-builder'

/**
 * Cloud hosts: daemon hosts HumanLayer provisions in a cloud sandbox (Cloudflare Containers,
 * Daytona or E2B) for the calling user. Once ready, a cloud host is an ordinary host in the
 * `online_hosts` list. See apps/cf-hosts/README.md for the provisioner behind these routes.
 */

export const CLOUD_HOST_DEFAULT_TTL_MINUTES = 24 * 60
export const CLOUD_HOST_MAX_TTL_MINUTES = 30 * 24 * 60
/** E2B sandboxes live at most 24 hours. */
export const CLOUD_HOST_E2B_MAX_TTL_MINUTES = 24 * 60

export const cloudHostSchema = z.object({
	hostId: z.string(),
	provider: CloudHostProviderSchema,
	status: CloudHostStatusSchema,
	/** Why the host failed or was removed; null otherwise. */
	error: z.string().nullable(),
	size: CloudHostSizeSchema.nullable(),
	ttlMinutes: z.number().int(),
	/** Epoch milliseconds. */
	createdAt: z.number(),
	expiresAt: z.number().nullable(),
	readyAt: z.number().nullable(),
	destroyedAt: z.number().nullable(),
	/** Bootstrap step the provisioner last reported (only from `get` while the host is starting). */
	bootstrapPhase: z.string().nullable().optional(),
})
export type CloudHostOutput = z.infer<typeof cloudHostSchema>

export const cloudHostProvidersOutputSchema = z.object({
	providers: z.array(
		z.object({
			provider: CloudHostProviderSchema,
			/** False when this deployment has no credentials for the provider. */
			available: z.boolean(),
		}),
	),
	defaultProvider: CloudHostProviderSchema,
})

export const listCloudHostProvidersContract = contractBuilder.input(z.object({})).output(cloudHostProvidersOutputSchema)

const credential = z.string().trim().min(1).max(16_384)

/**
 * Agent credentials, passed through to the host and never stored by HumanLayer. All optional:
 * without them the host still comes up and the agent can be signed in from the app.
 */
export const cloudHostCredentialsSchema = z.object({
	anthropicApiKey: credential.optional(),
	claudeCodeOauthToken: credential.optional(),
	githubToken: credential.optional(),
})

export const createCloudHostInputSchema = z
	.object({
		provider: CloudHostProviderSchema.default('cloudflare'),
		ttlMinutes: z.number().int().min(10).max(CLOUD_HOST_MAX_TTL_MINUTES).default(CLOUD_HOST_DEFAULT_TTL_MINUTES),
		/** Daytona only; other providers have a fixed size. */
		size: CloudHostSizeSchema.optional(),
		credentials: cloudHostCredentialsSchema.optional(),
	})
	.refine((input) => input.provider !== 'e2b' || input.ttlMinutes <= CLOUD_HOST_E2B_MAX_TTL_MINUTES, {
		message: 'E2B hosts last at most 24 hours',
		path: ['ttlMinutes'],
	})

export const cloudHostOutputSchema = z.object({ host: cloudHostSchema })

export const createCloudHostContract = contractBuilder.input(createCloudHostInputSchema).output(cloudHostOutputSchema)

export const listCloudHostsContract = contractBuilder
	.input(z.object({}))
	.output(z.object({ hosts: z.array(cloudHostSchema) }))

export const cloudHostIdInputSchema = z.object({ hostId: z.string().uuid() })

export const getCloudHostContract = contractBuilder.input(cloudHostIdInputSchema).output(cloudHostOutputSchema)

export const getCloudHostLogsContract = contractBuilder
	.input(cloudHostIdInputSchema.extend({ lines: z.number().int().min(1).max(2000).default(200) }))
	.output(z.object({ hostId: z.string(), bootstrap: z.string(), daemon: z.string() }))

export const destroyCloudHostContract = contractBuilder.input(cloudHostIdInputSchema).output(cloudHostOutputSchema)
