<script module lang="ts">
	import type { TagColorToken } from '$lib/domain/tags';

	/**
	 * Tag chips: a coloured dot plus the name, always both — colour never carries the information
	 * alone (see the accessibility note in colors.ts on TAG_COLORS).
	 *
	 * NOT built on Badge (ui/Badge.svelte): its pill/rounded variants hardcode `uppercase
	 * font-bold`, which reads right for a short status word and wrong for "Vacances Portugal
	 * 2026". A tag also needs the dot, the +N overflow and an optional remove control, none of
	 * which exist anywhere in the referential.
	 *
	 * Never a colour-filled chip: two small dots on a row stay readable, two colour blocks do not,
	 * and the row already carries a category pastille a few pixels away.
	 */
	export interface TagChipItem {
		/** Stable identity for the {#each} key and for onRemove: a tag id on saved rows, the tag
		 *  NAME inside TagPicker where a not-yet-created tag has no id. */
		key: string;
		name: string;
		/** null while a typed tag is unsaved. The colour comes from pickTagColorToken(nameKey), and
		 *  nameKey is a SHA-256 the server computes, so the client cannot know it in advance.
		 *  Rendering a neutral zinc dot is honest; guessing a colour that changes on save is not. */
		colorToken: TagColorToken | null;
		/** In-flight creation: this chip is optimistically shown while the create request is still
		 *  in flight. Renders a dashed border, a zinc-400 dot regardless of colorToken, and a
		 *  spinner — never removable mid-flight in the one caller (TagPicker) that sets this. */
		pending?: boolean;
	}
</script>

<script lang="ts">
	import { tagColorBgClass } from '$lib/domain/colors';
	import * as m from '$lib/paraglide/messages';

	let {
		tags,
		variant = 'plain',
		size = 'md',
		max = 2,
		onRemove
	}: {
		tags: TagChipItem[];
		/** plain: reading context (table row, dashboard widget) — no per-chip container, never
		 *  clickable, never wraps. enclosed: editing context (detail panel, mobile sheet,
		 *  TagPicker's own selected-chip row) — bordered pill, can carry a remove control, wraps. */
		variant?: 'plain' | 'enclosed';
		size?: 'sm' | 'md';
		/** Truncates RENDERING, not data: the full list is always received so the overflow button's
		 *  aria-label can name every hidden tag. Pass Infinity to disable the cap entirely — that is
		 *  what TagPicker's own selected-chip row does, since editing has no ceiling. */
		max?: number;
		/** Only enclosed chips can offer removal; a hidden tag must never be unremovable, so
		 *  passing onRemove disables the +N collapse regardless of `max`. */
		onRemove?: (key: string) => void;
	} = $props();

	const visible = $derived(onRemove ? tags : tags.slice(0, max));
	const hidden = $derived(onRemove ? [] : tags.slice(max));

	const sizeConfig = {
		sm: {
			dot: 'h-[7px] w-[7px]',
			text: 'text-xs',
			innerGap: 'gap-[5px]',
			chipGap: 'gap-2.5',
			maxWidth: 'max-w-[110px]'
		},
		md: {
			dot: 'h-2 w-2',
			text: 'text-[13px] font-medium',
			innerGap: 'gap-1.5',
			chipGap: 'gap-2',
			maxWidth: 'max-w-[240px] sm:max-w-[190px]'
		}
	} as const;

	const config = $derived(sizeConfig[size]);

	function overflowAria(names: string[]): string {
		return names.length === 1
			? m.tags_chips_overflow_aria_one({ n: names.length, names: names.join(', ') })
			: m.tags_chips_overflow_aria_many({ n: names.length, names: names.join(', ') });
	}

	// Deliberately NOT the shared Tooltip (ui/Tooltip.svelte): it wires an aria-describedby from
	// the trigger to the tooltip content, which here would duplicate the button's own aria-label —
	// the design explicitly forbids that for this control ("no aria-describedby pointing at the
	// Tooltip"), since the aria-label already names every hidden tag. This is a purely visual,
	// aria-hidden echo of that same label for sighted mouse/keyboard users. Escape closes it.
	let overflowOpen = $state(false);
</script>

{#if tags.length > 0}
	<ul
		class="inline-flex flex-wrap items-center {config.chipGap} {variant === 'plain'
			? 'flex-nowrap'
			: ''}"
		aria-label={m.tags_chips_group_aria()}
	>
		{#each visible as tag (tag.key)}
			<li>
				{#if variant === 'enclosed'}
					<span
						class="inline-flex items-center {config.innerGap} rounded-lg border px-2.5 py-1 {config.maxWidth} {tag.pending
							? 'border-dashed border-zinc-300 bg-zinc-50'
							: 'border-zinc-200 bg-zinc-50'}"
					>
						<span
							class="{config.dot} shrink-0 rounded-full {tag.pending
								? 'bg-zinc-400'
								: tag.colorToken
									? tagColorBgClass(tag.colorToken)
									: 'bg-zinc-300'}"
							aria-hidden="true"
						></span>
						<span
							class="min-w-0 truncate {config.text} {tag.pending
								? 'text-zinc-500'
								: 'text-zinc-700'}"
						>
							{tag.name}
						</span>
						{#if tag.pending}
							<svg
								data-testid="tag-chip-spinner"
								class="h-[11px] w-[11px] shrink-0 animate-[spin_0.8s_linear_infinite] text-zinc-400"
								viewBox="0 0 20 20"
								fill="none"
								aria-hidden="true"
							>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-opacity="0.25"
								/>
								<path d="M18 10a8 8 0 0 0-8-8" stroke="currentColor" stroke-width="2.5" />
							</svg>
						{:else if onRemove}
							<button
								type="button"
								class="relative -mr-0.5 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-zinc-400 before:absolute before:-inset-[11px] before:content-[''] hover:bg-zinc-200 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none sm:before:-inset-[1px]"
								aria-label={m.tags_remove_aria({ name: tag.name })}
								onclick={() => onRemove(tag.key)}
							>
								<svg viewBox="0 0 12 12" class="h-2.5 w-2.5" aria-hidden="true">
									<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" fill="none" />
								</svg>
							</button>
						{/if}
					</span>
				{:else}
					<span class="inline-flex items-center {config.innerGap} {config.maxWidth}">
						<span
							class="{config.dot} shrink-0 rounded-full {tag.colorToken
								? tagColorBgClass(tag.colorToken)
								: 'bg-zinc-300'}"
							aria-hidden="true"
						></span>
						<span class="min-w-0 truncate {config.text} text-zinc-700">{tag.name}</span>
					</span>
				{/if}
			</li>
		{/each}
		{#if hidden.length > 0}
			<li class="relative">
				<button
					type="button"
					class="inline-flex h-7 min-w-11 shrink-0 items-center justify-center rounded-md border px-1.5 text-[11.5px] font-semibold tabular-nums focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none sm:h-6 sm:min-w-6 {overflowOpen
						? 'border-zinc-900 bg-zinc-900 text-white'
						: 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'}"
					aria-label={overflowAria(hidden.map((tag) => tag.name))}
					onmouseenter={() => (overflowOpen = true)}
					onmouseleave={() => (overflowOpen = false)}
					onfocus={() => (overflowOpen = true)}
					onblur={() => (overflowOpen = false)}
					onkeydown={(event) => {
						if (event.key === 'Escape') overflowOpen = false;
					}}
				>
					{m.tags_chips_overflow_label({ n: hidden.length })}
				</button>
				{#if overflowOpen}
					<span
						aria-hidden="true"
						class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] leading-relaxed whitespace-nowrap text-white"
					>
						{#each hidden as tag (tag.key)}
							<span class="block">{tag.name}</span>
						{/each}
					</span>
				{/if}
			</li>
		{/if}
	</ul>
{/if}
