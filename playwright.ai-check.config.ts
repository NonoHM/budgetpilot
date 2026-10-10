import { defineConfig, devices } from '@playwright/test';

/**
 * `npm run ai:check` (#971): the real-model qualification run, kept out of `npm run test:e2e`
 * because it needs an Ollama with the model pulled and takes minutes per fixture on a CPU. No web
 * server here: the spec boots the build itself, pointed at its recording proxy.
 */
export default defineConfig({
	testDir: 'e2e/ai-check',
	testMatch: '**/*.spec.ts',
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	workers: 1,
	retries: 0,
	reporter: [['list']]
});
