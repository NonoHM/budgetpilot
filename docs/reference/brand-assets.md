# Brand assets

For contributors and for anyone running their own instance who needs a logo
file. Every file named here is generated; none is drawn by hand.

## Where the files come from

One script writes all of them from one source:

```bash
npm run brand:build
```

- `scripts/brand/marks.mjs` holds the geometry, the colours and the layouts.
  Change the brand there, never in a file under `static/`.
- `scripts/brand/build.mjs` writes the vectors, renders the PNG files with
  Chromium at their exact pixel size, and packs the ICO.
- `src/lib/brandAssets.spec.ts` fails when a committed file differs from what
  the script produces, when a file is added to `static/brand/` by hand, or when
  an icon is announced at a size it does not have.

## Colours

The brand uses three colours, all taken from Tailwind's default palette:

| Role   | Value     | Tailwind name | Used for                                        |
| ------ | --------- | ------------- | ----------------------------------------------- |
| Ink    | `#09090b` | zinc-950      | The tile, the wordmark on light backgrounds     |
| Paper  | `#fafafa` | zinc-50       | The ribbon on the tile, the wordmark on dark    |
| Accent | `#a3e635` | lime-400      | The back face of the ribbon, in every colourway |

## Logo files

Each logo comes in four colourways. Pick by the background it sits on:

| Suffix   | Background it is made for | Ribbon front | Ribbon back | Wordmark |
| -------- | ------------------------- | ------------ | ----------- | -------- |
| `-light` | White or light grey       | Ink          | Accent      | Ink      |
| `-dark`  | Black or dark grey        | Paper        | Accent      | Paper    |
| `-black` | Light, one colour only    | Ink          | Ink         | Ink      |
| `-white` | Dark, one colour only     | Paper        | Paper       | Paper    |

The one-colour versions are for print, engraving, or any place that cannot
reproduce the accent.

The following table lists the four logo shapes, each available in the four
colourways above:

| File                                  | Shape                                     | Use it for                                     |
| ------------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| `static/brand/logo-<way>.svg`         | Symbol beside the name. The primary logo. | Headers, the README, anything wide             |
| `static/brand/logo-stacked-<way>.svg` | Symbol above the name                     | Square spaces                                  |
| `static/brand/symbol-<way>.svg`       | The ribbon alone, no tile                 | Small spaces where the name is already visible |
| `static/brand/wordmark-<way>.svg`     | The name alone                            | Running text where a symbol would be noise     |

The name is outlined, not typed, so it renders the same on every device. It is
Inter Display SemiBold 4.001 with tracking at -0.02 em. The tools that
outlined it are in `scripts/brand/wordmark/`.

## Icon files

The following table lists every icon a browser or an operating system asks for:

| File                                 | Size             | Source              | Read by                                                   |
| ------------------------------------ | ---------------- | ------------------- | --------------------------------------------------------- |
| `static/favicon.ico`                 | 16, 32 and 48 px | `icon.svg`          | Older browsers and crawlers, which request it at the root |
| `static/brand/icon.svg`              | Vector           | Generated           | The browser tab                                           |
| `static/apple-touch-icon.png`        | 180 × 180 px     | `icon-full.svg`     | iPhone and iPad home screens                              |
| `static/brand/icon-192.png`          | 192 × 192 px     | `icon.svg`          | Android, through the manifest                             |
| `static/brand/icon-512.png`          | 512 × 512 px     | `icon.svg`          | Android splash screen, through the manifest               |
| `static/brand/icon-maskable-512.png` | 512 × 512 px     | `icon-maskable.svg` | Android launchers that crop icons to a shape              |
| `static/manifest.webmanifest`        | Not applicable   | Written by hand     | Browsers offering to install the app                      |

The three icon sources differ only in their background:

- `icon.svg` is the ink tile with rounded corners. The tile is part of the
  mark, so it stays the same on a light or a dark tab.
- `icon-full.svg` fills the square to its edges, because iOS rounds the corners
  itself.
- `icon-maskable.svg` fills the square and scales the ribbon to 80 %, so it
  stays inside the circle an Android launcher may crop to.

The `<link>` tags that announce these files are in `src/app.html`.

## Files for other surfaces

The following table lists the files made for places outside the app:

| File                               | Size          | Use it for                         |
| ---------------------------------- | ------------- | ---------------------------------- |
| `static/brand/avatar-500.png`      | 500 × 500 px  | A GitHub or social profile picture |
| `static/brand/social-1280x640.png` | 1280 × 640 px | The repository's social preview    |
| `static/brand/social.svg`          | Vector, 2:1   | The source of the preview above    |

## Rules of use

The rules for placing the logo, such as clear space, minimum size and what not
to do, are in `DESIGN.md`, section « Brand ».

For why the mark and its colours were chosen, see [the brand
identity](../explanation/brand-identity.md).
