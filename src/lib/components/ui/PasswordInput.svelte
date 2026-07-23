<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import * as m from '$lib/paraglide/messages';
	import { inputBase } from '$lib/styles';
	import IconButton from './IconButton.svelte';

	// Password field with a show/hide eye icon — the only field type that
	// carries this icon in the app (never email / token / TOTP code).
	let {
		value = $bindable(''),
		name,
		id,
		required = false,
		minlength,
		autocomplete,
		class: extraClass = '',
		onblur,
		...rest
	}: {
		value?: string;
		name: string;
		id?: string;
		required?: boolean;
		minlength?: HTMLInputAttributes['minlength'];
		autocomplete?: HTMLInputAttributes['autocomplete'];
		class?: string;
		onblur?: (event: FocusEvent) => void;
		[key: string]: unknown;
	} = $props();

	let show = $state(false);
</script>

<div class="relative">
	<input
		{id}
		{name}
		type={show ? 'text' : 'password'}
		class="w-full {inputBase} {extraClass} pr-12"
		{required}
		{minlength}
		{autocomplete}
		bind:value
		{onblur}
		{...rest}
	/>
	<IconButton
		class="absolute inset-y-0 right-0"
		label={show ? m.settings_password_hide_aria() : m.settings_password_show_aria()}
		onclick={() => (show = !show)}
	>
		{#if show}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
				<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
				<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
				<line x1="2" x2="22" y1="2" y2="22" />
			</svg>
		{:else}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
				<circle cx="12" cy="12" r="3" />
			</svg>
		{/if}
	</IconButton>
</div>
