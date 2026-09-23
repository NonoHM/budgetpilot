import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import AccountColumnDialog from './AccountColumnDialog.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * #485's one offer: does this file cover more than one account?
 *
 * NOT `ConfirmDialog`: that primitive is confirm-or-cancel, one substantive action and one plain
 * dismissal. This question has two substantive, mutually exclusive answers and no dismissal that
 * is not "leave the file unresolved", so the dialog composes `Modal` + `Button` directly, the same
 * one level down `ConfirmDialog` itself is built. See the component's own docstring.
 *
 * BREAK MATRIX, run at authoring time.
 * 1. Swap which button calls `onConfirmAccount` vs `onDenyAccount`: red on the role-scoped test
 *    below, exactly the class `DuplicateStatementDialog.svelte.spec.ts` already names.
 * 2. Drop the evidence line: red on the values-shown test, which is the whole argument for asking
 *    rather than refusing on vocabulary the user does not think in.
 */
function mount(overrides: { onConfirmAccount?: () => void; onDenyAccount?: () => void } = {}) {
	return render(AccountColumnDialog, {
		open: true,
		column: 3,
		header: 'Reference',
		samples: ['10000001', '10000002'],
		onConfirmAccount: overrides.onConfirmAccount ?? vi.fn(),
		onDenyAccount: overrides.onDenyAccount ?? vi.fn(),
		onClose: vi.fn()
	});
}

describe('AccountColumnDialog', () => {
	it('asks the question a user thinks in, not the vocabulary of the detector', async () => {
		const screen = mount();

		await expect.element(screen.getByText(m.import_account_column_title())).toBeInTheDocument();
	});

	it('shows the column and its own differing values as evidence', async () => {
		const screen = mount();

		await expect
			.element(
				screen.getByText(
					m.import_account_column_evidence({ header: 'Reference', values: '10000001, 10000002' })
				)
			)
			.toBeInTheDocument();
	});

	it('falls back to a numbered column when the file has no header', async () => {
		const screen = render(AccountColumnDialog, {
			open: true,
			column: 3,
			header: '',
			samples: ['10000001', '10000002'],
			onConfirmAccount: vi.fn(),
			onDenyAccount: vi.fn(),
			onClose: vi.fn()
		});

		await expect
			.element(
				screen.getByText(
					m.import_account_column_evidence_no_header({ count: 4, values: '10000001, 10000002' })
				)
			)
			.toBeInTheDocument();
	});

	it('calls onConfirmAccount from the button that answers "several accounts"', async () => {
		const onConfirmAccount = vi.fn();
		const onDenyAccount = vi.fn();
		const screen = mount({ onConfirmAccount, onDenyAccount });

		await screen.getByRole('button', { name: m.import_account_column_confirm() }).click();

		expect(onConfirmAccount).toHaveBeenCalledTimes(1);
		expect(onDenyAccount).not.toHaveBeenCalled();
	});

	it('calls onDenyAccount from the button that answers "something else"', async () => {
		const onConfirmAccount = vi.fn();
		const onDenyAccount = vi.fn();
		const screen = mount({ onConfirmAccount, onDenyAccount });

		await screen.getByRole('button', { name: m.import_account_column_deny() }).click();

		expect(onDenyAccount).toHaveBeenCalledTimes(1);
		expect(onConfirmAccount).not.toHaveBeenCalled();
	});
});
