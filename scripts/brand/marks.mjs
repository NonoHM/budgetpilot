// The brand's single source: geometry, colours and layouts of every vector file under static/brand/,
// and the list of rasters built from them. Pure: no I/O, so brandAssets.spec.ts can compare the
// committed files against it. Rules of use are in DESIGN.md, « Brand ».
import { WORDMARK_PATH } from './wordmark/path.mjs';

/** @typedef {{ front: string, back: string }} Way */
/** @typedef {{ from: string, sizes: number[] } | { from: string, width: number, height: number }} Raster */

export const COLORS = {
	ink: '#09090b', // zinc-950
	paper: '#fafafa', // zinc-50
	accent: '#a3e635' // lime-400
};

// Colourways: front faces and wordmark, back face. Light means "for a light background".
/** @type {Record<'light' | 'dark' | 'black' | 'white', Way>} */
const WAYS = {
	light: { front: COLORS.ink, back: COLORS.accent },
	dark: { front: COLORS.paper, back: COLORS.accent },
	black: { front: COLORS.ink, back: COLORS.ink },
	white: { front: COLORS.paper, back: COLORS.paper }
};

/** @param {number} v */
const n = (v) => +v.toFixed(2);

// The mark: a ribbon folded twice. Each run is a parallelogram with vertical ends, so neighbours meet
// on a shared fold edge. Units are the 32-unit icon grid; the ink box is x 8..24, y 7..25.
const POINTS = [8, 24, 8, 24].map((x, i) => [x, n(9.5 + (13 * i) / 3)]);
const THICKNESS = 5;
const runs = POINTS.slice(1).map(([x2, y2], i) => {
	const [x1, y1] = POINTS[i];
	const t = THICKNESS / 2;
	return `M${x1} ${n(y1 - t)}L${x2} ${n(y2 - t)}L${x2} ${n(y2 + t)}L${x1} ${n(y1 + t)}Z`;
});
// One colour cannot show the fold by tone, so each run that passes under the next is cut back along
// that run's outline by FOLD_GAP: the same edge the change of tone draws in the coloured mark.
const FOLD_GAP = 0.75;
// Runs 0 and 2 face front, run 1 is the back of the ribbon, drawn in that order.
/** @param {Way} way */
const ribbon = ({ front, back }) => {
	const fill = (/** @type {number} */ i) => (i === 1 ? back : front);
	if (front !== back) return runs.map((d, i) => `<path fill="${fill(i)}" d="${d}"/>`).join('');
	const cut = (/** @type {number} */ i) =>
		`<mask id="bp-fold-${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><path d="${runs[i + 1]}" fill="#000" stroke="#000" stroke-width="${2 * FOLD_GAP}" stroke-linejoin="round"/></mask>`;
	return (
		`<defs>${cut(0)}${cut(1)}</defs>` +
		runs
			.map(
				(d, i) => `<path fill="${fill(i)}" d="${d}"${i < 2 ? ` mask="url(#bp-fold-${i})"` : ''}/>`
			)
			.join('')
	);
};

/** @param {string} viewBox @param {string} body */
const svg = (viewBox, body) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img"><title>BudgetPilot</title>${body}</svg>\n`;

// Glyph scaled about the grid centre, for icons whose safe zone is smaller than the tile.
/** @param {number} k @param {string} body */
const scaled = (k, body) =>
	`<g transform="translate(${n(16 - 16 * k)} ${n(16 - 16 * k)}) scale(${k})">${body}</g>`;

// Lockups are laid out in font units on the wordmark's ink box (x 124..10400.4, y -1500..432).
const INK = { x0: 124, x1: 10400.4, top: -1500, bottom: 432 };
/** @param {string} fill @param {number} dx @param {number} dy */
const word = (fill, dx, dy) =>
	`<path fill="${fill}" transform="translate(${n(dx)} ${n(dy)})" d="${WORDMARK_PATH}"/>`;
/** @param {Way} way @param {number} x @param {number} y @param {number} s */
const symbolAt = (way, x, y, s) =>
	`<g transform="translate(${n(x - 8 * s)} ${n(y - 7 * s)}) scale(${s})">${ribbon(way)}</g>`;

// Horizontal: symbol 1.5 cap heights tall (cap 1490), centred on the cap middle, gap 0.36 symbol.
const H = { s: 125, gap: 800 };
/** @param {Way} way */
const horizontalBox = (way) => {
	const symW = 16 * H.s;
	const symTop = -745 - 9 * H.s;
	const textX = symW + H.gap - INK.x0;
	const top = Math.min(symTop, INK.top);
	const box = [0, n(top), n(textX + INK.x1), n(Math.max(symTop + 18 * H.s, INK.bottom) - top)];
	return { box, body: symbolAt(way, 0, symTop, H.s) + word(way.front, textX, 0) };
};
/** @param {Way} way */
const horizontal = (way) => {
	const { box, body } = horizontalBox(way);
	return svg(box.join(' '), body);
};

// Stacked: symbol centred above the wordmark, gap two thirds of a cap height.
const S = { s: 220, gap: 1000 };
/** @param {Way} way */
const stacked = (way) => {
	const inkW = INK.x1 - INK.x0;
	const symH = 18 * S.s;
	const baseline = symH + S.gap - INK.top;
	return svg(
		`0 0 ${n(inkW)} ${n(baseline + INK.bottom)}`,
		symbolAt(way, (inkW - 16 * S.s) / 2, 0, S.s) + word(way.front, -INK.x0, baseline)
	);
};

/** @param {Way} way */
const wordmark = (way) =>
	svg(`${INK.x0} ${INK.top} ${n(INK.x1 - INK.x0)} ${INK.bottom - INK.top}`, word(way.front, 0, 0));

// Social preview, 2:1: the dark horizontal lockup at 60 % of the width, centred.
const social = () => {
	const [W, Hh] = [1280, 640];
	const { box, body } = horizontalBox(WAYS.dark);
	const w = W * 0.6;
	const h = (w * box[3]) / box[2];
	return svg(
		`0 0 ${W} ${Hh}`,
		`<rect width="${W}" height="${Hh}" fill="${COLORS.ink}"/><svg x="${n((W - w) / 2)}" y="${n((Hh - h) / 2)}" width="${n(w)}" height="${n(h)}" viewBox="${box.join(' ')}">${body}</svg>`
	);
};

/**
 * Every vector file, keyed by its path under static/.
 * @returns {Record<string, string>}
 */
export function brandSvgs() {
	const tile = `<rect width="32" height="32" rx="7" fill="${COLORS.ink}"/>`;
	const bleed = `<rect width="32" height="32" fill="${COLORS.ink}"/>`;
	/** @type {Record<string, string>} */
	const files = {
		// The app icon: the tile is part of the mark, and it reads on any tab or wallpaper.
		'brand/icon.svg': svg('0 0 32 32', tile + ribbon(WAYS.dark)),
		// Full bleed: iOS and avatars round the corners themselves.
		'brand/icon-full.svg': svg('0 0 32 32', bleed + ribbon(WAYS.dark)),
		// Maskable: the launcher may crop to a circle of 40 % radius; the glyph is scaled into it.
		'brand/icon-maskable.svg': svg('0 0 32 32', bleed + scaled(0.8, ribbon(WAYS.dark))),
		'brand/social.svg': social()
	};
	for (const [way, colors] of Object.entries(WAYS)) {
		files[`brand/symbol-${way}.svg`] = svg('8 7 16 18', ribbon(colors));
		files[`brand/logo-${way}.svg`] = horizontal(colors);
		files[`brand/logo-stacked-${way}.svg`] = stacked(colors);
		files[`brand/wordmark-${way}.svg`] = wordmark(colors);
	}
	return files;
}

/**
 * Rasters built from the vectors above, keyed by their path under static/. `sizes` packs an ICO
 * from square PNG frames; `width` and `height` are one PNG.
 * @type {Record<string, Raster>}
 */
export const RASTERS = {
	'favicon.ico': { from: 'brand/icon.svg', sizes: [16, 32, 48] },
	'apple-touch-icon.png': { from: 'brand/icon-full.svg', width: 180, height: 180 },
	'brand/icon-192.png': { from: 'brand/icon.svg', width: 192, height: 192 },
	'brand/icon-512.png': { from: 'brand/icon.svg', width: 512, height: 512 },
	'brand/icon-maskable-512.png': { from: 'brand/icon-maskable.svg', width: 512, height: 512 },
	'brand/avatar-500.png': { from: 'brand/icon-full.svg', width: 500, height: 500 },
	'brand/social-1280x640.png': { from: 'brand/social.svg', width: 1280, height: 640 }
};
