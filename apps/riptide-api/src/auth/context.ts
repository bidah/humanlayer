import * as Sentry from '@sentry/node'
import { Effect } from 'effect'
import { decodeJwt } from 'jose'

import type { AppRuntime } from '../effects/app-runtime'
import logger from '../logger'
import { type CloudHostTokenGate, cloudHostTokenGate } from './cloud-host-revocation'
import { validateDaemonToken } from './daemon-tokens'
import { type AuthContextOptionalOrg, validateJWT } from './jwt-validator'
import { authenticatePersonalAccessToken } from './personal-access-tokens'

export const resolveUserAuthContext = Effect.fn('auth.resolve_user_auth_context')(function* (input: {
	authorizationHeader: string | null
}) {
	const match = input.authorizationHeader?.match(/^Bearer (.+)$/)
	if (!match?.[1]) return null
	const credential = match[1]
	if (isJwtCredential(credential)) {
		return yield* Effect.promise(() => validateJWT(credential))
	}
	return yield* authenticatePersonalAccessToken({ value: credential })
})

function isJwtCredential(credential: string): boolean {
	try {
		decodeJwt(credential)
		return true
	} catch {
		return false
	}
}

export async function getAuthContext(req: Request, runtime: AppRuntime): Promise<AuthContextOptionalOrg | null> {
	try {
		const authHeader = req.headers.get('authorization')
		if (!authHeader) {
			logger.warn('Missing authorization header')
			return null
		}
		return await runtime.runPromise(resolveUserAuthContext({ authorizationHeader: authHeader }))
	} catch (error) {
		Sentry.captureException(error, {
			tags: { error_type: 'auth_failure' },
		})
		logger.error(error, 'Error getting auth context')
		throw error
	}
}

export type DaemonAuthContext = {
	userId: string
	organizationId: string
	hostId: string
	/** The token was minted for a cloud host (`cloud_hosts`); see auth/cloud-host-revocation.ts. */
	cloudHost?: boolean
}

export async function getDaemonAuthContext(
	req: Request,
	gate: CloudHostTokenGate = cloudHostTokenGate(),
): Promise<DaemonAuthContext | null> {
	const daemonAuthHeader = req.headers.get('x-daemon-authorization')
	if (!daemonAuthHeader) {
		logger.warn('Missing daemon authorization header')
		return null
	}

	try {
		const validated = await validateDaemonToken(daemonAuthHeader)
		if (!validated) {
			logger.warn('Invalid daemon token')
			return null
		}

		// Only cloud host tokens are revocable; ordinary daemon tokens skip the lookup entirely.
		if (validated.cloudHost === true && !(await gate.isActive(validated))) {
			logger.warn('Rejected revoked cloud host daemon token', { hostId: validated.hostId })
			return null
		}

		const context: DaemonAuthContext = {
			userId: validated.userId,
			organizationId: validated.organizationId,
			hostId: validated.hostId,
		}
		if (validated.cloudHost === true) context.cloudHost = true
		return context
	} catch (error) {
		Sentry.captureException(error, {
			tags: { error_type: 'auth_failure' },
		})
		logger.error('Error validating daemon token', { error })
		return null
	}
}
