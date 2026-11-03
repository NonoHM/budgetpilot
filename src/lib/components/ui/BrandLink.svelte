<script lang="ts">
	import { asset, resolve } from '$app/paths';
</script>

<!--
	The horizontal lockup (static/brand/logo-light.svg) with live text: the symbol is 1.5 cap heights
	tall and sits 0.36 of its height from the name, as in the generated file. The image is decorative,
	the link's name is the text. Rules of use: DESIGN.md, « Brand ».
-->
<a
	class="inline-flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-zinc-950"
	href={resolve('/')}
	><img
		src={asset('/brand/symbol-light.svg')}
		alt=""
		width="23"
		height="26"
		class="h-[1.625rem] w-auto shrink-0"
	/>BudgetPilot</a
>
