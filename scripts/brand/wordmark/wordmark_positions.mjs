// Kerned x position of each glyph of the wordmark, in font units, measured by Chromium (which applies
// the font's GPOS kerning). pos(i) = width(text[0..i]) - width(text[i]), so the pair (i-1, i) is in it.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [fontPath, text, upem, out] = process.argv.slice(2);
const font = readFileSync(fontPath).toString('base64');
const browser = await chromium.launch();
try {
	const page = await browser.newPage();
	await page.setContent(
		`<style>@font-face{font-family:W;src:url(data:font/ttf;base64,${font})}</style><span style="font-family:W">${text}</span>`
	);
	const pos = await page.evaluate(
		async ([text, upem]) => {
			await document.fonts.load(`${upem}px W`);
			const ctx = document.createElement('canvas').getContext('2d');
			ctx.font = `${upem}px W`;
			const w = (s) => ctx.measureText(s).width;
			if (Math.abs(w('B') - w('i')) < 1)
				throw new Error('font did not load: B and i measure alike');
			return { x: [...text].map((ch, i) => w(text.slice(0, i + 1)) - w(ch)), total: w(text) };
		},
		[text, +upem]
	);
	writeFileSync(out, JSON.stringify(pos));
	console.log(out, pos.x.length, 'glyphs, total', pos.total.toFixed(1));
} finally {
	await browser.close();
}
