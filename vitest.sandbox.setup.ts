/**
 * Loads .env into process.env for the sandbox validation harness (Node >= 21 native
 * loader — values, including secrets, stay in process env and are never printed by
 * the harness; it only ever logs SHAPES and non-sensitive scalars).
 */
try {
	process.loadEnvFile('.env');
} catch {
	// No .env: the harness's first check will report the missing configuration clearly.
}
