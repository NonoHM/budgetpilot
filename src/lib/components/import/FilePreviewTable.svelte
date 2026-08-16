<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { MAPPING_ROLES, type MappingRole } from '$lib/domain/mappingRoles';
	import { roleLabel } from '$lib/domain/columnMappingLabels';
	import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

	/**
	 * « Aperçu du fichier » — the desktop half of the designation screen.
	 *
	 * ## Local on purpose, and NOT the referential's table
	 *
	 * The referential still has no table brique while eight screens ship one (#332, measurement in
	 * #363). This is deliberately not it. Registering the shared component from THIS screen would
	 * define it from its rarest case: a read-only table with no sort, no selection and no clickable
	 * row — that is, stripped of nearly everything the other eight do. #332's ordering stands, and
	 * when the brique exists this file is its first consumer to be absorbed, not its source.
	 *
	 * It is built now because the alternative shipped worse: at 1280 the screen was a 400 px column
	 * with 855 px of measured blank beside it, on the one screen a user meets when the application
	 * has already failed to read their statement.
	 *
	 * ## Every figure below comes from the plate, not from taste
	 *
	 * 806 px of region, 772 of content once the border and the 2x16 padding are removed. Columns
	 * are 132 px, except the one holding the Libellé role at 200 — `132 x 4 + 200 = 728` in 772, so
	 * five whole columns and a fragment of the sixth, which is what tells the reader the table
	 * scrolls. Header row 40, data rows 44.
	 *
	 * ## The rows are REAL rows
	 *
	 * `previewRows`, never `samples`. Samples are chosen per column because they discriminate, so
	 * two on the same index come from different rows of the file; drawn as a grid they would invent
	 * a transaction the statement does not contain. See `server/import/previewRows.spec.ts`, which
	 * measures the two disagreeing.
	 *
	 * ## Columns are NOT reordered
	 *
	 * The plate decided this and it is not a layout preference: pulled to the left, the designated
	 * columns would make the preview a second source of truth contradicting the same file opened in
	 * a spreadsheet.
	 *
	 * ## Nothing here is a tap target
	 *
	 * No cell is a control, so the table is excluded from the tab order — and only from the tab
	 * order. It IS in the accessibility tree and traversable in browse mode like any table, which
	 * is why the header cells carry `scope="col"` (#363: 0 of 66 across the product; new markup
	 * does not add to that figure).
	 */
	let {
		file,
		assignment
	}: {
		file: DesignationFile;
		assignment: RoleAssignment;
	} = $props();

	const LABEL_COLUMN_WIDTH = 200;
	const COLUMN_WIDTH = 132;

	/**
	 * Which role, if any, each column index carries.
	 *
	 * A plain record rather than a `Map`: this is derived state rebuilt on every change, so the
	 * reactive-collection rule does not apply and a record reads more directly at the call sites.
	 */
	const roleAt = $derived.by(() => {
		const byIndex: Record<number, MappingRole> = {};
		for (const role of MAPPING_ROLES) {
			const index = assignment[role];
			if (index !== null && index !== undefined) byIndex[index] = role;
		}
		return byIndex;
	});

	const rows = $derived(file.previewRows ?? []);
	const columnCount = $derived(file.headers.length);

	const widthAt = (index: number) =>
		roleAt[index] === 'label' ? LABEL_COLUMN_WIDTH : COLUMN_WIDTH;

	/**
	 * The table's own width, stated.
	 *
	 * `table-layout: fixed` on a table with no width is laid out against its CONTAINER, so the
	 * per-column widths become proportions and every column compresses. Measured before this: a
	 * 13-column file drew nine columns inside 774 px while the indicator said five were visible —
	 * the widths were ignored and the figure beside them was then false.
	 */
	const tableWidth = $derived(
		file.headers.reduce((total, _header, index) => total + widthAt(index), 0)
	);

	/**
	 * How many columns fit whole in 772 px, for the « 1-5 / 15 » indicator.
	 *
	 * Computed from the same widths the cells use rather than measured from the DOM: a figure read
	 * back from layout would be right and untestable, and this one is asserted.
	 */
	const visibleColumns = $derived.by(() => {
		let used = 0;
		let fitted = 0;
		for (let index = 0; index < columnCount; index += 1) {
			used += roleAt[index] === 'label' ? LABEL_COLUMN_WIDTH : COLUMN_WIDTH;
			if (used > 772) break;
			fitted += 1;
		}
		return Math.max(1, fitted);
	});
</script>

{#if rows.length > 0}
	<section
		class="flex min-w-0 flex-1 flex-col gap-2"
		data-testid="designation-preview"
		aria-label={m.import_columns_preview_heading()}
	>
		<div class="flex items-baseline justify-between">
			<h2 class="text-[11px] font-bold tracking-[0.04em] text-zinc-500 uppercase">
				{m.import_columns_preview_heading()}
			</h2>
			<!--
				The scroll indicator. It says how much of the file's WIDTH is on screen, which is the
				one thing a horizontally scrolling table hides: a reader who cannot see column 12
				has no way to know it exists.
			-->
			<p class="text-[11.5px] text-zinc-500 tabular-nums" data-testid="designation-preview-range">
				{m.import_columns_preview_range({
					shown: Math.min(visibleColumns, columnCount),
					total: columnCount
				})}
			</p>
		</div>

		<!--
			`tabindex="-1"` and NOT 0. The region scrolls, and a scrollable region normally earns a
			tab stop so a keyboard user can reach it — but every value in here is also in the picker
			cards, which ARE in the tab order, so a stop would be a second route to the same content
			with nothing to do at the end of it.
		-->
		<div
			class="overflow-x-auto overflow-y-hidden rounded-xl border border-zinc-200 bg-white p-4"
			data-testid="designation-preview-scroller"
		>
			<table
				class="border-separate border-spacing-0 text-left"
				style="table-layout: fixed; width: {tableWidth}px;"
			>
				<caption class="sr-only">
					{m.import_columns_preview_caption({ name: file.name })}
				</caption>
				<thead>
					<tr>
						{#each file.headers as header, index (index)}
							{@const role = roleAt[index]}
							<th
								scope="col"
								class="sticky top-0 h-[40px] border-b border-zinc-200 bg-white pr-4 align-bottom"
								style="width: {widthAt(index)}px;"
							>
								{#if role}
									<!--
										Two lines, in the plate's order: the ROLE first because it is the answer
										the user just gave, the file's own header under it because that is what
										they will recognise when they open the file again.
									-->
									<span
										class="block truncate text-[9.5px] leading-[13px] font-bold tracking-[0.04em] text-zinc-900 uppercase"
										>{roleLabel(role)}</span
									>
									<span class="block truncate text-[11.5px] leading-[16px] text-zinc-500"
										>{header || m.import_columns_header_absent_short({ index: index + 1 })}</span
									>
								{:else}
									<!--
										An ignored column is zinc-400, the referential's redundant-content tier,
										and it is correct here because the command column already says which
										columns carry a role. It is dimmed, never hidden: a column the user did
										not designate is exactly what they scan for when a value is missing.
									-->
									<span class="block truncate text-[11.5px] leading-[16px] text-zinc-400"
										>{header || m.import_columns_header_absent_short({ index: index + 1 })}</span
									>
								{/if}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each rows as row, rowIndex (rowIndex)}
						<tr>
							{#each file.headers as _header, index (index)}
								{@const role = roleAt[index]}
								<td
									class="h-[44px] truncate border-b border-zinc-100 pr-4 text-[12.5px] {role
										? 'text-zinc-900'
										: 'text-zinc-400'}"
									style="max-width: {widthAt(index)}px;"
								>
									{row[index] ?? ''}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}
