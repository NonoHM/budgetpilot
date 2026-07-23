import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Avatar from './Avatar.svelte';

describe('Avatar.svelte', () => {
	it('defaults to the 36px navbar size', async () => {
		render(Avatar, { initials: 'PB' });

		const avatar = page.getByText('PB');
		await expect.element(avatar).toHaveClass(/h-9/);
		await expect.element(avatar).toHaveClass(/w-9/);
	});

	it.each([
		[24, 'h-6', 'w-6'],
		[32, 'h-8', 'w-8'],
		[36, 'h-9', 'w-9'],
		[56, 'h-14', 'w-14']
	] as const)('renders the %spx size with %s %s', async (size, heightClass, widthClass) => {
		render(Avatar, { initials: 'PB', size });

		const avatar = page.getByText('PB');
		await expect.element(avatar).toHaveClass(new RegExp(heightClass));
		await expect.element(avatar).toHaveClass(new RegExp(widthClass));
	});
});
