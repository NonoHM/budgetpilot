// Writes every brand file under static/ from scripts/brand/marks.mjs: the vectors as text, the
// rasters rendered by Chromium at device scale 1, the ICO packed from PNG frames.
// Usage: npm run brand:build
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandSvgs, RASTERS } from './marks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../static');
const svgs = brandSvgs();

for (const [path, text] of Object.entries(svgs)) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
}

/** PNG width and height from the IHDR chunk. */
export function pngSize(buf) {
	if (buf.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG: no IHDR at byte 12');
	return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

// ICO with PNG frames (supported by every browser since Windows Vista's format revision).
function ico(frames) {
	const header = Buffer.alloc(6 + 16 * frames.length);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(frames.length, 4);
	let offset = header.length;
	frames.forEach(({ size, png }, i) => {
		const e = 6 + 16 * i;
		header.writeUInt8(size % 256, e);
		header.writeUInt8(size % 256, e + 1);
		header.writeUInt16LE(1, e + 4);
		header.writeUInt16LE(32, e + 6);
		header.writeUInt32LE(png.length, e + 8);
		header.writeUInt32LE(offset, e + 12);
		offset += png.length;
	});
	return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	const render = async (from, width, height) => {
		await page.setViewportSize({ width, height });
		const src = 'data:image/svg+xml;base64,' + Buffer.from(svgs[from]).toString('base64');
		await page.setContent(
			`<body style="margin:0"><img src="${src}" width="${width}" height="${height}" style="display:block">`
		);
		await page.waitForFunction(
			() => document.images[0].complete && document.images[0].naturalWidth > 0
		);
		const png = await page.screenshot({
			omitBackground: true,
			clip: { x: 0, y: 0, width, height }
		});
		const [w, h] = pngSize(png);
		if (w !== width || h !== height)
			throw new Error(`${from} rendered ${w}x${h}, expected ${width}x${height}`);
		return png;
	};
	// One page, so every render runs in sequence: a concurrent render would resize the page under another.
	for (const [path, r] of Object.entries(RASTERS)) {
		let out;
		if ('sizes' in r) {
			const frames = [];
			for (const size of r.sizes) frames.push({ size, png: await render(r.from, size, size) });
			out = ico(frames);
		} else {
			out = await render(r.from, r.width, r.height);
		}
		writeFileSync(join(root, path), out);
	}
} finally {
	await browser.close();
}
console.log(
	`brand: ${Object.keys(svgs).length} vectors, ${Object.keys(RASTERS).length} rasters written under static/`
);
