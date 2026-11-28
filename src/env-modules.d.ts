// SvelteKit 3 keeps `$env/dynamic/private` as a deprecated alias of `$app/env/private` and no longer
// types it. The values are the names `src/env.ts` declares (#1336).
declare module '$env/dynamic/private' {
	export const env: Record<string, string | undefined>;
}
