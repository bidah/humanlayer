import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		globalSetup: ['test/global-setup.ts'],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// Test files share one wrangler dev instance and its D1; run them one at a time.
		fileParallelism: false,
	},
})
