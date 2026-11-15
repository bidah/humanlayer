import { getOptionalWorkerEnv } from '../platform/worker-env'
import { requireEnvironment } from './environment'
import { R2SignedUrlService } from './r2-signed-url-service'
import { type IS3Service, S3Service } from './s3-service'

/**
 * R2-backed storage when running as a Cloudflare Worker with an `ARTIFACTS` bucket binding and no
 * explicit S3 credentials (`S3_ACCESS_KEY_ID`); otherwise undefined and callers use S3 as before.
 */
export function makeR2ObjectStorageIfConfigured(): R2SignedUrlService | undefined {
	const bucket = getOptionalWorkerEnv()?.ARTIFACTS
	if (!bucket || process.env.S3_ACCESS_KEY_ID) return undefined
	return new R2SignedUrlService({
		bucket,
		signingSecret: requireEnvironment('ARTIFACT_URL_SIGNING_SECRET'),
		publicOrigin: () => requireEnvironment('RIPTIDE_API_ORIGIN'),
	})
}

/**
 * Object storage used for presigned artifact/upload URLs: R2 on Cloudflare (see above), otherwise
 * the existing S3 presigner configured from the S3_* env vars.
 */
export function createObjectStorage(): IS3Service {
	return (
		makeR2ObjectStorageIfConfigured() ??
		new S3Service(
			requireEnvironment('S3_ARTIFACTS_BUCKET'),
			requireEnvironment('S3_ARTIFACTS_REGION', 'us-east-1'),
			process.env.S3_ARTIFACTS_ENDPOINT,
			process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
				? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
				: undefined,
		)
	)
}
