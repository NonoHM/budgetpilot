import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import CheckboxField from './CheckboxField.svelte';

/**
 * The referential gap's first consumer (#378).
 *
 * `layout.css` is imported because the height below is a real measurement. Without it the
 * assertion reads a plausible number instead of failing, which this repository has measured twice.
 */
describe('CheckboxField.svelte', () => {
	function mount(props: Record<string, unknown> = {}) {
		const { container } = render(CheckboxField, {
			name: 'deleteOldImport',
			label: "Supprimer l'ancien import",
			checked: true,
			...props
		});
		container.style.width = '390px';
		return container;
	}

	it('clears the 44 px floor at the mobile breakpoint', () => {
		// The V2 precedence clause, which exists because three triggers shipped at 40 and a fourth
		// at 36, each defensible on its own screen. ABSOLUTE and not a comparison against a sibling:
		// a relative assertion passes with no stylesheet loaded at all.
		const row = mount().querySelector('label') as HTMLElement;

		expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});

	it('posts an unambiguous value when it is UNTICKED', () => {
		// The whole reason this component exists rather than a bare <input type="checkbox">. An
		// unchecked box is absent from the submission, so « the user said no » and « the field was
		// never added » arrive as the same thing, and this control decides a delete.
		const container = mount({ checked: false });

		const hidden = container.querySelector('input[type="hidden"][name="deleteOldImport"]');
		expect(hidden).toHaveValue('false');
	});

	it('posts exactly one entry for its name, whichever way it is set', () => {
		// Two named fields would make the answer depend on DOM order, since `formData.get` returns
		// the first entry. Counted rather than reasoned about, in both states.
		for (const checked of [true, false]) {
			const container = mount({ checked });

			expect(container.querySelectorAll('[name="deleteOldImport"]')).toHaveLength(1);
		}
	});

	it('posts true when it is ticked', () => {
		const container = mount({ checked: true });

		expect(container.querySelector('input[type="hidden"]')).toHaveValue('true');
	});

	it('renders the note when given one, and describes the control with it', () => {
		const container = mount({ note: 'Les répartitions seront supprimées.' });

		const input = container.querySelector('input[type="checkbox"]') as HTMLElement;
		const described = input.getAttribute('aria-describedby');
		expect(described).not.toBeNull();
		expect(container.querySelector(`#${described}`)?.textContent).toBe(
			'Les répartitions seront supprimées.'
		);
	});

	it('renders NOTHING extra when there is no note', () => {
		// The direction this is not moving in, and the owner's condition on shipping it: a warning
		// about a loss that cannot occur is discounted every time after. The app knows which case it
		// is in, so it answers rather than hedges.
		const container = mount();

		expect(container.querySelector('p')).toBeNull();
		expect(container.querySelector('input[type="checkbox"]')).not.toHaveAttribute(
			'aria-describedby'
		);
	});

	it('carries no tint in either state, against a detector calibrated on a real tint', () => {
		// The referential reserves colour for the destructive, the late, and a tag's identity. This
		// control deletes and is still none of the three: the deletion is the repair the user came
		// for and they have done nothing wrong. Asserted on the RENDERED colour rather than on the
		// class string, so a tint arriving through a different utility is caught too.
		//
		// THE FIRST VERSION OF THIS TEST MEASURED THE HARNESS. It read `color.match(/\d+/g)` as an
		// rgb triple, and this palette computes to `oklch()`: the digits it compared were the
		// lightness and hue of a colour space it was not written for. It failed, which is the only
		// reason it was noticed at all. So the detector is calibrated here, on the two figures that
		// decide it, rather than against a threshold chosen by eye.
		//
		// CHROMA is the channel that means tint. Measured 2026-08-17 in this stylesheet:
		// `text-rose-700` is oklch(0.514 0.222 16.935) and `text-zinc-500` is
		// oklch(0.552 0.016 285.938). The zinc family is not chromatically zero, which is why the
		// bound is 0.05 rather than 0, and rose sits four times above it.
		const chromaOf = (element: Element) => {
			const parsed = getComputedStyle(element).color.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
			expect(parsed, 'the palette stopped computing to oklch, recalibrate').not.toBeNull();
			return Number(parsed![2]);
		};

		// The detector proves it can detect BEFORE it is believed on an absence. A tint the product
		// really uses, rendered through the same stylesheet, in the same document.
		const control = document.createElement('span');
		control.className = 'text-rose-700';
		document.body.append(control);
		expect(chromaOf(control)).toBeGreaterThan(0.05);
		control.remove();

		for (const checked of [true, false]) {
			const container = mount({ checked });

			expect(chromaOf(container.querySelector('label span')!)).toBeLessThan(0.05);
		}
	});
});
