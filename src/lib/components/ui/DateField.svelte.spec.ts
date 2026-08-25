import { describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import DateField from './DateField.svelte';
import { isoToDisplay } from '$lib/domain/dateField';
import * as m from '$lib/paraglide/messages';

/**
 * One date box, in a plain GET form, written in the app's own grammar.
 *
 * The pair of elements is the whole design: what the reader edits is TEXT in jj/mm/aaaa, and what
 * the form submits is a hidden ISO value under the caller's `name`. Splitting them is what lets a
 * screen keep its existing `method="GET"` form and its existing server parsing while losing the
 * native picker, which renders in the BROWSER's locale rather than the app's.
 */
describe('DateField.svelte', () => {
	/**
	 * Separates "the box is the app's own field" from "the box is the browser's date picker". This
	 * is the defect itself, so it is asserted on the element rather than inferred from what it
	 * shows: a native input rendering jj/mm/aaaa on THIS machine looks identical to a correct one,
	 * and would look different on a machine set to en-US. Reading the attribute is the only check
	 * that cannot be fooled by the locale the test happens to run in.
	 */
	it('is a text field, never a native date picker', async () => {
		expect.assertions(3);
		await page.viewport(1280, 900);

		const { container } = render(DateField, { name: 'from', value: '2026-08-01' });

		expect(container.querySelector('input[type="date"]')).toBeNull();
		const visible = container.querySelector('input[type="text"]');
		expect(visible).not.toBeNull();
		expect(visible?.getAttribute('inputmode')).toBe('numeric');
	});

	/**
	 * Separates "the reader sees the app's order" from "the reader sees ISO". Called through
	 * `isoToDisplay` rather than retyped, so the expectation cannot drift from the grammar by
	 * exactly the clause a retyped oracle forgets.
	 */
	it('shows a stored ISO value in the app’s jj/mm/aaaa order', async () => {
		await page.viewport(1280, 900);

		const { container } = render(DateField, { name: 'from', value: '2026-08-01' });

		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(visible.value).toBe(isoToDisplay('2026-08-01'));
		expect(visible.value).toBe('01/08/2026');
	});

	/**
	 * Separates "the form submits ISO" from "the form submits what the reader typed". The server
	 * parses ISO, so this is the assertion that decides whether the swap works at all rather than
	 * merely looks right.
	 */
	it('submits ISO under the caller’s name, not the displayed text', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const { container } = render(DateField, { name: 'from', value: '2026-08-01' });

		const hidden = container.querySelector('input[name="from"]') as HTMLInputElement;
		expect(hidden.type).toBe('hidden');
		expect(hidden.value).toBe('2026-08-01');
	});

	/**
	 * The live half. Separates "the submitted value follows what is typed" from "it is only correct
	 * on first render", which is the state a static render cannot tell apart.
	 */
	it('follows what the reader types', async () => {
		await page.viewport(1280, 900);

		const { container } = render(DateField, { name: 'from', value: '' });
		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

		await userEvent.fill(visible, '25/12/2026');

		const hidden = container.querySelector('input[name="from"]') as HTMLInputElement;
		expect(hidden.value).toBe('2026-12-25');
	});

	/**
	 * Separates "an unfinished or impossible entry submits nothing" from "it submits a fragment".
	 * 31/02/2026 matches the shape exactly and is not a day; submitting it would send the range,
	 * get it refused, and show the reader an invalid state for input this field had accepted
	 * without a word.
	 */
	it('submits nothing for an entry that is not a real date', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);

		const { container } = render(DateField, { name: 'from', value: '' });
		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
		const hidden = container.querySelector('input[name="from"]') as HTMLInputElement;

		await userEvent.fill(visible, '05/06/202');
		expect(hidden.value).toBe('');

		await userEvent.fill(visible, '31/02/2026');
		expect(hidden.value).toBe('');
	});

	/**
	 * Separates "the box follows a value the PAGE changes" from "the box shows whatever it was first
	 * given". Both forms using this component navigate with GET, and SvelteKit re-renders the same
	 * component instance with new props rather than remounting it, so choosing a preset in the
	 * period Select beside the field must move the field. Svelte's own
	 * `state_referenced_locally` warning is what surfaced this: the first version seeded `display`
	 * from `value` once and would have shown the previous period's dates for ever after.
	 */
	it('follows a value the page changes underneath it', async () => {
		await page.viewport(1280, 900);

		const { container, rerender } = render(DateField, { name: 'from', value: '2026-08-01' });
		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(visible.value).toBe('01/08/2026');

		await rerender({ name: 'from', value: '2026-07-01' });

		expect(visible.value).toBe('01/07/2026');
		expect((container.querySelector('input[name="from"]') as HTMLInputElement).value).toBe(
			'2026-07-01'
		);
	});

	/**
	 * The other side of the same rule, and it is what stops the fix above becoming a different bug:
	 * a re-render that does NOT change `value` must leave a half-typed buffer alone. Reseeding on
	 * every render would rewrite the field under the reader's cursor whenever anything else on the
	 * page changed.
	 */
	it('leaves what the reader is typing alone when the value has not changed', async () => {
		await page.viewport(1280, 900);

		const { container, rerender } = render(DateField, { name: 'from', value: '2026-08-01' });
		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

		await userEvent.fill(visible, '25/12');
		await rerender({ name: 'from', value: '2026-08-01' });

		expect(visible.value).toBe('25/12');
	});

	/**
	 * MEASURED REGRESSION, and the reason this block exists.
	 *
	 * On /rapports, typing 31/02/2026 and pressing « Afficher » came back with NO query string at
	 * all: the page silently showed the default period, with no banner, no `aria-invalid` and no
	 * message. The reader asked for a period, got a different one, and nothing said so. The native
	 * input this component replaced made that state unreachable, because a date widget will not let
	 * an impossible day be entered in the first place.
	 *
	 * So refusing the value (which the field already did) is only half the job. Saying so is the
	 * other half, and it is what the swap owes.
	 */
	describe('an entry it cannot read', () => {
		/**
		 * Separates "the field says the date was not understood" from "the field silently drops it".
		 * Both leave the submitted value empty, which is why the assertion is on the announcement and
		 * not on the value: the value was already correct in the version that shipped the regression.
		 */
		it('marks itself invalid on blur and points at a message that says so', async () => {
			expect.assertions(3);
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.fill(visible, '31/02/2026');
			await userEvent.tab();

			expect(visible.getAttribute('aria-invalid')).toBe('true');
			const messageId = visible.getAttribute('aria-describedby');
			expect(messageId).not.toBeNull();
			expect(container.querySelector(`#${messageId}`)?.textContent?.trim()).not.toBe('');
		});

		/**
		 * The form must not be submittable while a box says it was not understood. Asserted through
		 * `checkValidity`, which is the mechanism the surrounding `method="GET"` form actually
		 * consults, rather than through a proxy that would pass while the form still submitted.
		 */
		it('blocks its form from submitting', async () => {
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.fill(visible, '31/02/2026');
			await userEvent.tab();

			expect(visible.checkValidity()).toBe(false);
		});

		/**
		 * MEASURED BYPASS of the guard above, and the reason the refusal no longer waits for blur.
		 *
		 * Pressing Enter in a text field is implicit submission and does NOT fire `blur`. With the
		 * invalid state gated on a `touched` flag that only `onblur` set, Enter left the field
		 * "untouched", `setCustomValidity` empty, and the form submitted with an empty value:
		 * measured on /rapports as `?period=this-month&from=&to=2026-08-31`, which renders a period
		 * the reader did not choose. Exactly the defect the state exists to close, reached by the
		 * other of the two ways a person submits a form.
		 *
		 * So constraint validity is now computed from the BUFFER alone, and only the visible red and
		 * the announced message wait for blur.
		 */
		it('refuses the value before any blur, so Enter cannot submit it', async () => {
			expect.assertions(2);
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.fill(visible, '31/02/2026');
			// No blur, no tab. This is the state the field is in when Enter is pressed.
			expect(visible.checkValidity()).toBe(false);
			// And it stays quiet until the reader leaves, so it does not shout mid-typing.
			expect(visible.getAttribute('aria-invalid')).toBeNull();
		});

		/**
		 * The browser fires `invalid` on a field when constraint validation blocks a submit. That is
		 * the moment the reader finds out, so it is the moment the field must also SHOW it, rather
		 * than staying quiet because they never tabbed away.
		 */
		it('shows itself once the browser blocks a submit on it', async () => {
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.fill(visible, '31/02/2026');
			visible.dispatchEvent(new Event('invalid'));
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(visible.getAttribute('aria-invalid')).toBe('true');
		});

		/**
		 * MEASURED DEAD STYLE. The first version appended `border-rose-400` to a class string that
		 * already carried `border-zinc-200`. Same specificity, and Tailwind emits rose before zinc,
		 * so zinc won and the red border never painted: the computed value on /rapports was
		 * `oklch(0.92 0.004 286.32)`, which is zinc-200.
		 *
		 * Asserted on the COMPUTED colour rather than on the class list, because the class list was
		 * correct in the version that did not render. A class assertion would have been green
		 * throughout.
		 */
		it('actually paints a different border when invalid', async () => {
			expect.assertions(2);
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '2026-08-01' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
			const resting = getComputedStyle(visible).borderColor;

			await userEvent.fill(visible, '31/02/2026');
			await userEvent.tab();

			const flagged = getComputedStyle(visible).borderColor;
			expect(flagged).not.toBe(resting);
			// A positive figure beside the difference: an empty string would also "not equal".
			expect(flagged.length).toBeGreaterThan(0);
		});

		/**
		 * Separates "invalid until corrected" from "invalid for ever". A state that cannot be left is
		 * worse than one that never fires, because the reader has no way out of it.
		 */
		it('clears once the entry becomes a real date', async () => {
			expect.assertions(2);
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.fill(visible, '31/02/2026');
			await userEvent.tab();
			await userEvent.fill(visible, '28/02/2026');
			await userEvent.tab();

			expect(visible.getAttribute('aria-invalid')).toBeNull();
			expect(visible.checkValidity()).toBe(true);
		});

		/**
		 * The over-firing guard, and it is what stops the fix becoming its own defect: an EMPTY
		 * optional field is not an error. Marking it invalid would put a red ring and a message on
		 * every unset date box on the page before the reader has done anything at all.
		 */
		it('says nothing about an empty field', async () => {
			expect.assertions(2);
			await page.viewport(1280, 900);

			const { container } = render(DateField, { name: 'from', value: '' });
			const visible = container.querySelector('input[type="text"]') as HTMLInputElement;

			await userEvent.click(visible);
			await userEvent.tab();

			expect(visible.getAttribute('aria-invalid')).toBeNull();
			expect(visible.checkValidity()).toBe(true);
		});
	});

	/**
	 * The accessible name, which is the half a purely visual check misses. A caller that gives no
	 * visible label must still give the field a name a screen reader can read, and the placeholder
	 * is not one: it disappears the moment the reader types.
	 */
	it('carries the accessible name the caller gives it', async () => {
		await page.viewport(1280, 900);

		const { container } = render(DateField, {
			name: 'from',
			value: '',
			ariaLabel: m.reports_from_label()
		});

		const visible = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(visible.getAttribute('aria-label')).toBe(m.reports_from_label());
	});
});
