<script lang="ts">
	// Full dashboard-page skeleton, shown only during a same-route client-side
	// navigation (period-selector change — see +page.svelte's isNavigatingDashboard).
	// Mirrors the real layout's exact shape (KPI row, collapsed insights bar, main/side
	// explicit flex columns) so nothing shifts once real data replaces it.
	import { cardBase } from '$lib/styles';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import * as m from '$lib/paraglide/messages';

	const pulse = 'skeleton-pulse rounded bg-zinc-200';
</script>

<div
	role="status"
	aria-label={m.dashboard_loading_aria()}
	class="mt-6 flex flex-col gap-6 lg:gap-8"
>
	<!-- KPIs -->
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
		{#each [0, 1, 2] as _ (_)}
			<div class="{cardBase} px-5 py-5 lg:py-4">
				<div class="{pulse} h-3 w-16"></div>
				<div class="{pulse} mt-2.5 h-7 w-28"></div>
			</div>
		{/each}
	</div>

	<!-- Insights bar (collapsed shape) -->
	<div class="{cardBase} flex h-[52px] items-center px-5 lg:px-4">
		<div class="{pulse} h-3.5 w-40"></div>
	</div>

	<div class="flex flex-wrap items-start gap-6 lg:gap-8">
		<!-- Main column -->
		<div class="flex min-w-full flex-1 flex-col gap-6 lg:min-w-[480px] lg:basis-[560px] lg:gap-8">
			<div class="{cardBase} p-5">
				<div class="{pulse} h-3.5 w-44"></div>
				<div class="mt-3.5 flex flex-col gap-1">
					<Skeleton />
					<Skeleton />
					<Skeleton />
				</div>
			</div>
			<div class="{cardBase} flex h-[52px] items-center px-5 lg:px-4">
				<div class="{pulse} h-3.5 w-32"></div>
			</div>
		</div>

		<!-- Side column -->
		<div class="flex min-w-full flex-1 flex-col gap-6 lg:min-w-[300px] lg:basis-[320px] lg:gap-8">
			<div class="{cardBase} p-5">
				<div class="{pulse} h-3.5 w-32"></div>
				<div class="mt-4 flex flex-col gap-4">
					{#each [0, 1] as _ (_)}
						<div>
							<div class="{pulse} h-2.5 w-20"></div>
							<div class="{pulse} mt-2 h-1.5 w-full rounded-full"></div>
						</div>
					{/each}
				</div>
			</div>
			<!-- Upcoming bills (see UpcomingBillsCard) — 3 ghost rows, never 5: the real card can show
			     up to 5, but the mobile viewport (and this skeleton, which never shows the desktop-only
			     rows) only has room for 3. -->
			<div class="{cardBase} p-5">
				<div class="{pulse} h-3.5 w-32"></div>
				<div class="mt-3.5 flex flex-col gap-3.5">
					{#each [0, 1, 2] as _ (_)}
						<div class="flex items-center gap-3">
							<div class="{pulse} h-8 w-8 shrink-0 rounded-full"></div>
							<div class="min-w-0 flex-1">
								<div class="{pulse} h-3 w-3/5"></div>
								<div class="{pulse} mt-1.5 h-2.5 w-2/5"></div>
							</div>
							<div class="{pulse} h-3 w-10 shrink-0"></div>
						</div>
					{/each}
				</div>
			</div>

			<div class="{cardBase} p-5">
				<div class="{pulse} h-3.5 w-36"></div>
				<div class="mt-4 rounded-xl border border-zinc-200 p-3.5">
					<div class="{pulse} h-3 w-24"></div>
					<div class="{pulse} mt-2.5 h-1.5 w-full rounded-full"></div>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	.skeleton-pulse {
		animation: skeleton-pulse 1.6s ease-in-out infinite;
	}

	@keyframes skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton-pulse {
			animation: none;
			opacity: 1;
		}
	}
</style>
