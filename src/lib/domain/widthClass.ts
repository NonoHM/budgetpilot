// Every percentage-based progress bar in the app (budget usage, focus-mode progress, report
// bars) used to be rendered with a dynamic `style="width: {pct}%"`, which is incompatible with
// a `style-src` CSP that has no `unsafe-inline`. Since a percentage bar only ever needs an
// integer 0-100 value, the fix is to enumerate every possible width as a static Tailwind
// arbitrary-value class ahead of time and pick the matching one at render time — no inline
// style ever gets generated.
//
// The 101 class names below (`w-[0%]` .. `w-[100%]`) are written out literally rather than
// built by string concatenation/template literals: Tailwind's build-time content scanner only
// picks up class names that appear verbatim as text in a source file, so a computed
// `` `w-[${i}%]` `` would silently fail to generate the corresponding CSS.
const WIDTH_PERCENT_CLASSES = [
	'w-[0%]',
	'w-[1%]',
	'w-[2%]',
	'w-[3%]',
	'w-[4%]',
	'w-[5%]',
	'w-[6%]',
	'w-[7%]',
	'w-[8%]',
	'w-[9%]',
	'w-[10%]',
	'w-[11%]',
	'w-[12%]',
	'w-[13%]',
	'w-[14%]',
	'w-[15%]',
	'w-[16%]',
	'w-[17%]',
	'w-[18%]',
	'w-[19%]',
	'w-[20%]',
	'w-[21%]',
	'w-[22%]',
	'w-[23%]',
	'w-[24%]',
	'w-[25%]',
	'w-[26%]',
	'w-[27%]',
	'w-[28%]',
	'w-[29%]',
	'w-[30%]',
	'w-[31%]',
	'w-[32%]',
	'w-[33%]',
	'w-[34%]',
	'w-[35%]',
	'w-[36%]',
	'w-[37%]',
	'w-[38%]',
	'w-[39%]',
	'w-[40%]',
	'w-[41%]',
	'w-[42%]',
	'w-[43%]',
	'w-[44%]',
	'w-[45%]',
	'w-[46%]',
	'w-[47%]',
	'w-[48%]',
	'w-[49%]',
	'w-[50%]',
	'w-[51%]',
	'w-[52%]',
	'w-[53%]',
	'w-[54%]',
	'w-[55%]',
	'w-[56%]',
	'w-[57%]',
	'w-[58%]',
	'w-[59%]',
	'w-[60%]',
	'w-[61%]',
	'w-[62%]',
	'w-[63%]',
	'w-[64%]',
	'w-[65%]',
	'w-[66%]',
	'w-[67%]',
	'w-[68%]',
	'w-[69%]',
	'w-[70%]',
	'w-[71%]',
	'w-[72%]',
	'w-[73%]',
	'w-[74%]',
	'w-[75%]',
	'w-[76%]',
	'w-[77%]',
	'w-[78%]',
	'w-[79%]',
	'w-[80%]',
	'w-[81%]',
	'w-[82%]',
	'w-[83%]',
	'w-[84%]',
	'w-[85%]',
	'w-[86%]',
	'w-[87%]',
	'w-[88%]',
	'w-[89%]',
	'w-[90%]',
	'w-[91%]',
	'w-[92%]',
	'w-[93%]',
	'w-[94%]',
	'w-[95%]',
	'w-[96%]',
	'w-[97%]',
	'w-[98%]',
	'w-[99%]',
	'w-[100%]'
] as const;

// Clamps to [0, 100] and rounds to the nearest integer before looking up the matching static
// class — any out-of-range or fractional value (e.g. a budget overspent past 100%, or a
// percentage with decimals) still resolves to a valid entry in the table above.
export function widthClass(percent: number): string {
	if (!Number.isFinite(percent)) return WIDTH_PERCENT_CLASSES[0];
	const clamped = Math.min(100, Math.max(0, percent));
	const rounded = Math.round(clamped);
	return WIDTH_PERCENT_CLASSES[rounded];
}
