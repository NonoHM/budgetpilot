import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import DashboardSkeleton from './DashboardSkeleton.svelte';

describe('DashboardSkeleton.svelte', () => {
	it('exposes a role="status" region with the loading accessible label', async () => {
		render(DashboardSkeleton, {});

		const status = page.getByRole('status');
		await expect.element(status).toBeInTheDocument();
		await expect.element(status).toHaveAttribute('aria-label', m.dashboard_loading_aria());
	});
});
