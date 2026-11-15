export function bytesToBase64(bytes: Uint8Array): string {
	let bin = ''
	const CHUNK = 0x8000
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
	}
	return btoa(bin)
}

export function stringToBase64(s: string): string {
	return bytesToBase64(new TextEncoder().encode(s))
}

export function base64ToString(b64: string): string {
	const bin = atob(b64)
	const bytes = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
	return new TextDecoder().decode(bytes)
}
