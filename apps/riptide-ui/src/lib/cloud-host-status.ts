import type { CloudHostProvider, CloudHostStatus } from '@humanlayer/db/tables/cloud-hosts'

/** Presentation rules for cloud hosts (hosts HumanLayer starts in a cloud sandbox). */

export const CLOUD_HOST_PROVIDER_LABELS: Record<CloudHostProvider, string> = {
	cloudflare: 'Cloudflare',
	daytona: 'Daytona',
	e2b: 'E2B',
}

export const CLOUD_HOST_STATUS_LABELS: Record<CloudHostStatus, string> = {
	provisioning: 'Starting sandbox',
	bootstrapping: 'Installing daemon',
	ready: 'Ready',
	failed: 'Failed',
	destroying: 'Deleting',
	destroyed: 'Deleted',
}

/** Statuses that change on their own and are worth polling. */
export function isCloudHostSettling(status: CloudHostStatus): boolean {
	return status === 'provisioning' || status === 'bootstrapping' || status === 'destroying'
}

export function isCloudHostStarting(status: CloudHostStatus): boolean {
	return status === 'provisioning' || status === 'bootstrapping'
}

/** Logs only exist while a sandbox does. */
export function canReadCloudHostLogs(status: CloudHostStatus): boolean {
	return status !== 'destroyed' && status !== 'destroying'
}

export const CLOUD_HOST_TTL_OPTIONS = [
	{ minutes: 60, label: '1 hour' },
	{ minutes: 4 * 60, label: '4 hours' },
	{ minutes: 24 * 60, label: '24 hours' },
	{ minutes: 7 * 24 * 60, label: '7 days' },
] as const

export const CLOUD_HOST_DEFAULT_TTL_MINUTES = 24 * 60
/** E2B sandboxes live at most 24 hours. */
export const E2B_MAX_TTL_MINUTES = 24 * 60

export function ttlOptionsFor(provider: CloudHostProvider) {
	return CLOUD_HOST_TTL_OPTIONS.filter((option) => provider !== 'e2b' || option.minutes <= E2B_MAX_TTL_MINUTES)
}

/** `Expires in 3 h`, `Expires in 12 min`, `Expired`. */
export function describeCloudHostExpiry(expiresAt: number | null, now: number): string | null {
	if (expiresAt === null) return null
	const remainingMs = expiresAt - now
	if (remainingMs <= 0) return 'Expired'
	const minutes = Math.round(remainingMs / 60_000)
	if (minutes < 60) return `Expires in ${Math.max(minutes, 1)} min`
	const hours = Math.round(minutes / 60)
	if (hours < 48) return `Expires in ${hours} h`
	return `Expires in ${Math.round(hours / 24)} days`
}

/** Error descriptions for the create and delete toasts. Raw server text is never the title. */
export function describeCloudHostError(error: unknown, fallback: string): string {
	const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
	const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined
	const serverMessage =
		data && typeof data === 'object' && 'message' in data && typeof data.message === 'string' ? data.message : null
	switch (code) {
		case 'BAD_REQUEST':
			return serverMessage ?? fallback
		case 'SERVICE_UNAVAILABLE':
			return 'The cloud provider did not respond. Try again in a minute.'
		case 'UNAUTHORIZED':
			return 'Your session has expired. Sign in again before retrying.'
		case 'ORGANIZATION_REQUIRED':
			return 'Select an organization before retrying.'
		case 'BILLING_REQUIRED':
		case 'UPGRADE_REQUIRED':
			return 'Billing must be updated before you can create a cloud host. Ask an organization admin.'
		default:
			return fallback
	}
}
