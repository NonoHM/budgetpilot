<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';

	/**
	 * The one row that names where a tag's lifecycle is administered, rendered identically by the
	 * two surfaces where a user asks the question: the tag filter's panel and the TagPicker.
	 *
	 * One component rather than two copies, deliberately. The design requires "la même rangée, au
	 * même endroit, avec le même libellé" in both, and this repo has watched a duplicated decision
	 * drift silently twice already (the detection-window clamps, feedsCashFlowProjection).
	 *
	 * An <a>, not a <button>: the destination is an address, so middle-click and open-in-a-new-tab
	 * must work. The route is /settings — there is no /parametres and no reroute hook, so the
	 * design's "/parametres#etiquettes" is spelled /settings#tags here.
	 *
	 * The second line is what actually answers "comment je supprime". It is NOT aria-hidden: the
	 * accessible name concatenates both lines, because a row announcing only a destination
	 * announces a place without announcing a capability.
	 *
	 * Never disabled, and rendered in every panel state including "no tag exists yet" and "loading
	 * failed": it depends on no data, and the zero-tag state is exactly where someone learns the
	 * management surface exists before needing it.
	 *
	 * It is deliberately OUTSIDE the listbox at both call sites — a sibling, not an option. It must
	 * not be counted into "3 éléments", and the arrow keys must never reach it. Tab does.
	 */
</script>

<a
	href="{resolve('/settings')}#tags"
	class="flex min-h-[56px] items-center justify-between gap-2 border-t border-zinc-200 bg-zinc-50 px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none sm:min-h-12"
	aria-label={m.tags_manage_footer_aria()}
>
	<span class="min-w-0">
		<!-- 48px desktop / 56px mobile against 34px list rows: the difference in gabarit is the
		     first signal that this row is not selectable, before anything is hovered. -->
		<span class="block truncate text-sm font-medium text-zinc-900 lg:hover:underline"
			>{m.tags_manage_footer_label()}</span
		>
		<span class="block truncate text-xs text-zinc-500">{m.tags_manage_footer_sub()}</span>
	</span>
	<!-- Chevron right: you leave this surface. Not a toggle, not an action in place. -->
	<svg class="h-4 w-4 shrink-0 text-zinc-400" viewBox="0 0 20 20" fill="none" aria-hidden="true">
		<path
			d="M7.5 5.5 12 10l-4.5 4.5"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
</a>
