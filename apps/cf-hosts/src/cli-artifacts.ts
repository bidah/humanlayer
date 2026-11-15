import type { CliArtifact } from './providers/types'
import { ProviderError } from './providers/types'

/** The binary cloud hosts install (the manifest's top-level `key`/`sha256`/`size`). */
export const CLI_BINARY_NAME = 'humanlayer-linux-x64'
const VERSION_RE = /^[A-Za-z0-9._-]{1,80}$/
/** `humanlayer-<platform>` file names, as built by scripts/build-cli.ts (and apps/cli/build.ts). */
const PLATFORM_FILE_RE = /^humanlayer-((?:linux|darwin)-(?:x64|arm64)|win32-x64\.exe)$/

export interface CliPlatformArtifact {
	key: string
	sha256: string
	size: number
}

export interface CliManifest {
	version: string
	gitSha: string
	dirty: boolean
	cliVersion: string
	platform: 'linux-x64'
	key: string
	sha256: string
	size: number
	origins: Record<string, string>
	builtAt: string
	/**
	 * Every binary of this version by file name (`humanlayer-darwin-arm64`, ...), including
	 * linux-x64. Absent in manifests that only carry the linux-x64 binary.
	 */
	files?: Record<string, CliPlatformArtifact>
}

/** The artifact for a `humanlayer-<platform>` file name, or null when this version has none. */
export function platformArtifact(manifest: CliManifest, file: string): CliPlatformArtifact | null {
	if (file === CLI_BINARY_NAME) return { key: manifest.key, sha256: manifest.sha256, size: manifest.size }
	if (!PLATFORM_FILE_RE.test(file)) return null
	return manifest.files?.[file] ?? null
}

/** Minimal R2 surface used here (lets tests pass a fake). */
export interface ArtifactBucket {
	get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string; json<T>(): Promise<T> } | null>
	head(key: string): Promise<{ size: number; httpEtag: string } | null>
}

export async function readManifest(bucket: ArtifactBucket, version?: string): Promise<CliManifest | null> {
	if (version !== undefined && !VERSION_RE.test(version)) return null
	const key = version ? `cli/${version}/manifest.json` : 'cli/latest.json'
	const obj = await bucket.get(key)
	return obj ? obj.json<CliManifest>() : null
}

/** Resolve the artifact a new host should download, as a URL on this Worker's public origin. */
export async function resolveCliArtifact(
	bucket: ArtifactBucket,
	publicOrigin: string,
	version?: string,
): Promise<CliArtifact> {
	const m = await readManifest(bucket, version)
	if (!m) {
		throw new ProviderError(
			version ? 'invalid_request' : 'provider_error',
			version
				? `CLI artifact version ${version} not found`
				: 'no CLI artifact published (run scripts/build-cli.ts --upload)',
			version ? 400 : 503,
		)
	}
	return { url: `${publicOrigin}/cli/${m.version}/${CLI_BINARY_NAME}`, sha256: m.sha256, version: m.version }
}

/** GET/HEAD /cli/:version/:file where version may be `latest`. Public: the binary has no secrets. */
export async function serveCliArtifact(
	bucket: ArtifactBucket,
	version: string,
	file: string,
	method: string,
): Promise<Response> {
	if (version !== 'latest' && !VERSION_RE.test(version)) return new Response('not found', { status: 404 })
	if (file !== 'manifest.json' && !PLATFORM_FILE_RE.test(file)) return new Response('not found', { status: 404 })
	const manifest = await readManifest(bucket, version === 'latest' ? undefined : version)
	if (!manifest) return new Response('not found', { status: 404 })
	if (file === 'manifest.json') {
		return Response.json(manifest, {
			headers: { 'cache-control': version === 'latest' ? 'no-cache' : 'public, max-age=31536000, immutable' },
		})
	}
	const artifact = platformArtifact(manifest, file)
	if (!artifact) return new Response('not found', { status: 404 })
	const headers = new Headers({
		'content-type': 'application/octet-stream',
		'content-disposition': `attachment; filename="${file.endsWith('.exe') ? 'humanlayer.exe' : 'humanlayer'}"`,
		'x-humanlayer-cli-version': manifest.version,
		'x-checksum-sha256': artifact.sha256,
		'cache-control': version === 'latest' ? 'no-cache' : 'public, max-age=31536000, immutable',
	})
	if (method === 'HEAD') {
		const h = await bucket.head(artifact.key)
		if (!h) return new Response(null, { status: 404 })
		headers.set('content-length', String(h.size))
		headers.set('etag', h.httpEtag)
		return new Response(null, { headers })
	}
	const obj = await bucket.get(artifact.key)
	if (!obj) return new Response('not found', { status: 404 })
	headers.set('content-length', String(obj.size))
	headers.set('etag', obj.httpEtag)
	return new Response(obj.body, { headers })
}
