import { describe, expect, it } from 'vitest';
import {
	getAdjacentFocusStackId,
	getFocusOutcomeForAction,
	getRemainingFocusStackIds,
	getSwipeProgress,
	resolveSwipeDecision
} from './transactionFocus';

describe('resolveSwipeDecision', () => {
	it('renvoie "accept" seulement au-delà du seuil vers la droite', () => {
		expect(resolveSwipeDecision(100, 100)).toBe('accept');
		expect(resolveSwipeDecision(150, 100)).toBe('accept');
	});

	it('renvoie "ignore" seulement au-delà du seuil vers la gauche', () => {
		expect(resolveSwipeDecision(-100, 100)).toBe('ignore');
		expect(resolveSwipeDecision(-150, 100)).toBe('ignore');
	});

	it('renvoie null en-deçà du seuil (frôlement accidentel, pas de décision) — données financières : pas de faux positif', () => {
		expect(resolveSwipeDecision(99, 100)).toBeNull();
		expect(resolveSwipeDecision(-99, 100)).toBeNull();
		expect(resolveSwipeDecision(0, 100)).toBeNull();
	});
});

describe('getSwipeProgress', () => {
	it('renvoie un ratio proportionnel entre 0 et 1 vers la droite', () => {
		expect(getSwipeProgress(50, 100)).toBe(0.5);
	});

	it('renvoie un ratio proportionnel entre -1 et 0 vers la gauche', () => {
		expect(getSwipeProgress(-50, 100)).toBe(-0.5);
	});

	it('plafonne à 1 / -1 au-delà du seuil (pas de sur-intensité visuelle)', () => {
		expect(getSwipeProgress(500, 100)).toBe(1);
		expect(getSwipeProgress(-500, 100)).toBe(-1);
	});

	it('renvoie 0 pour un seuil invalide (évite une division par zéro)', () => {
		expect(getSwipeProgress(50, 0)).toBe(0);
	});
});

describe('getFocusOutcomeForAction', () => {
	it('classe "accept" comme "accepted"', () => {
		expect(getFocusOutcomeForAction('accept')).toBe('accepted');
	});

	it('classe "ignore" comme "ignored"', () => {
		expect(getFocusOutcomeForAction('ignore')).toBe('ignored');
	});

	it('classe "createRule" comme "accepted" (catégorise la transaction courante, comme Accepter)', () => {
		expect(getFocusOutcomeForAction('createRule')).toBe('accepted');
	});
});

describe('getRemainingFocusStackIds', () => {
	it("retire les ids déjà traités en conservant l'ordre", () => {
		expect(getRemainingFocusStackIds(['a', 'b', 'c'], new Set(['b']))).toEqual(['a', 'c']);
	});

	it("renvoie la pile complète si rien n'est traité", () => {
		expect(getRemainingFocusStackIds(['a', 'b'], new Set())).toEqual(['a', 'b']);
	});
});

describe('getAdjacentFocusStackId', () => {
	it("navigue vers le suivant quand l'id courant est encore dans la pile restante", () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(), 'a', 'next')).toBe('b');
	});

	it("navigue vers le précédent quand l'id courant est encore dans la pile restante", () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(), 'c', 'previous')).toBe('b');
	});

	it('renvoie null pour "next" sur le dernier élément restant', () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(), 'c', 'next')).toBeNull();
	});

	it('renvoie null pour "previous" sur le premier élément restant', () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(), 'a', 'previous')).toBeNull();
	});

	it("saute les ids traités entre l'id courant et le suivant restant", () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c', 'd'], new Set(['b', 'c']), 'a', 'next')).toBe(
			'd'
		);
	});

	it("trouve le prochain restant après avoir traité l'id courant (auto-avance)", () => {
		// b was just handled: it is both currentId and in handledIds.
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(['b']), 'b', 'next')).toBe('c');
	});

	it("trouve le précédent restant après avoir traité l'id courant (auto-avance)", () => {
		expect(getAdjacentFocusStackId(['a', 'b', 'c'], new Set(['b']), 'b', 'previous')).toBe('a');
	});

	it('renvoie null quand plus aucun id ne reste', () => {
		expect(getAdjacentFocusStackId(['a', 'b'], new Set(['a', 'b']), 'b', 'next')).toBeNull();
	});

	it("renvoie null quand l'id courant traité est en bout de pile sans suite", () => {
		expect(
			getAdjacentFocusStackId(['a', 'b', 'c'], new Set(['a', 'b', 'c']), 'c', 'next')
		).toBeNull();
	});

	it("renvoie null si l'id courant n'appartient pas à la pile", () => {
		expect(getAdjacentFocusStackId(['a', 'b'], new Set(), 'z', 'next')).toBeNull();
	});

	it('renvoie null pour une pile vide dès le départ (next)', () => {
		expect(getAdjacentFocusStackId([], new Set(), 'a', 'next')).toBeNull();
	});

	it('renvoie null pour une pile vide dès le départ (previous)', () => {
		expect(getAdjacentFocusStackId([], new Set(), 'a', 'previous')).toBeNull();
	});

	it("renvoie null quand toute la pile est déjà traitée et que l'id courant est absent (déjà retiré ailleurs)", () => {
		expect(getAdjacentFocusStackId(['a', 'b'], new Set(['a', 'b']), 'z', 'next')).toBeNull();
	});

	// Regression: "Accept" used to close focus mode instead of advancing. Actual cause:
	// +page.svelte continuously derived `focusStackIds` from `data.classifyStackIds` (refreshed by
	// the form's update()); once a transaction was accepted with a real category, the server
	// removes it from the stack — it's then no longer "handled within the stack" but absent from
	// the stack itself, so `stackIds.indexOf(currentId)` (fallback line after the `remaining`
	// fast-path) falls to -1 like an id that never belonged to the stack, and the function
	// returns null → focus mode closed after every acceptance. The stack passed to this
	// function MUST therefore stay frozen for the duration of the focus session (captured once
	// on open, never re-derived from server data that changes after each action) — that's what
	// this test guarantees: with a frozen stack (currentId still present, just absent from
	// `remaining` once in handledIds), the next one is correctly found.
	it('avance vers le suivant après acceptation, tant que le stack passé reste figé (pas re-dérivé du serveur)', () => {
		const frozenStackAtFocusOpen = ['a', 'b', 'c'];
		// "a" was just accepted: added to handledIds, but the frozen stack still contains it.
		expect(getAdjacentFocusStackId(frozenStackAtFocusOpen, new Set(['a']), 'a', 'next')).toBe('b');
	});

	it("documente le bug : un stack non figé (id retiré, pas juste marqué handled) casse l'avance", () => {
		// Simulates the stack already refreshed by the server after acceptance: "a" no longer
		// appears AT ALL (not just in handledIds) — this is the mutation that caused the regression.
		const liveStackAfterServerRefresh = ['b', 'c'];
		expect(
			getAdjacentFocusStackId(liveStackAfterServerRefresh, new Set(['a']), 'a', 'next')
		).toBeNull();
	});
});

describe('getRemainingFocusStackIds — cas limites', () => {
	it('renvoie un tableau vide pour une pile vide dès le départ', () => {
		expect(getRemainingFocusStackIds([], new Set())).toEqual([]);
	});

	it('renvoie un tableau vide quand tous les ids sont déjà traités', () => {
		expect(getRemainingFocusStackIds(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
	});

	it('ignore les ids traités qui ne font pas partie de la pile (déjà retirés ailleurs)', () => {
		expect(getRemainingFocusStackIds(['a', 'b'], new Set(['z']))).toEqual(['a', 'b']);
	});
});
