# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (Node ≥20).
- `npm run dev` — Vite dev server with hot reload (serves `index.html`).
- `npm run build` — produce the single distributable. Output is renamed by a post-build hook in `vite.config.js` to `dist/invoice-generator-v<package.json version>.html`. Bump the version in `package.json` before building a release.

There are no tests and no lint config. There is no CI.

## Architecture

This is a **single-file offline browser app**. The build inlines all JS/CSS/fonts into one HTML so the artifact runs straight from the filesystem with no network access. The implications shape the codebase:

- **No dynamic imports / no code splitting** — enforced by `vite-plugin-singlefile` + `assetsInlineLimit: 100000000` + `inlineDynamicImports: true` in `vite.config.js`. Don't introduce lazy chunks or fetched assets.
- **No runtime network calls.** All fonts (`src/fonts.js`, ~225 KB base64 WOFFs) and libraries (pdf-lib, fontkit, pako) are bundled. Never add a CDN URL or `fetch()` for assets.
- **No framework.** Plain DOM, `$ = document.getElementById`. UI markup lives in `index.html`; logic attaches by id.
- **All state in `localStorage`**, keys namespaced `erechnung:*:v1` (see top of `src/main.js`). The version suffix is the migration boundary — bump it and write a migration if you change a schema.

### Module layout

- `index.html` — the static UI shell. Every interactive element has an id used by `main.js`. Translatable strings carry `data-i18n="<key>"`.
- `src/main.js` (~5000 lines) — application logic. Organized as banner-comment sections (`// -------- <name> --------`). Major sections, in order: State / Helpers / i18n / Storage / Seller / Buyer / Invoice number / Filename pattern / Footnote presets / History / YoY / Statistics / Items / PDF drop / Country normalization / XML generation / Actions / Font loader / PDF dispatcher / PDF/A output intent / XML embedding / Backup / Seller collapse / Help modal / History modal / Embed-XML modal / Init / Bootstrap. Use grep for the banner comment to jump to a section.
- `src/layouts.js` — the three invoice PDF renderers (`renderInvoiceModern`, `renderInvoiceDIN5008`, `renderInvoiceTypewriter`) plus shared layout helpers (`shrinkToFit`, `formatPartyAddress`, `drawCenteredBankLine`, `drawJustifiedLines`, `paginateItems`). Exported via the `LAYOUTS` registry — adding a layout means adding an entry there and a renderer function.
- `src/utils.js` — `round2`, `fmt`, `fmtPDF`. Keep dependency-free.
- `src/fonts.js` — base64 WOFF data for the five embedded monospace fonts. Don't read this file casually (huge); use grep with a font key.
- `src/styles.css` — all UI styling, theme tokens for light/dark/auto.

### PDF pipeline (the non-obvious part)

The PDF/XML pipeline is split across three files and has tight coupling worth knowing before editing:

1. `buildXML()` in `main.js` produces the Factur-X EN 16931 (Comfort, `urn:cen.eu:en16931:2017`) XML from form state. Tax modes (`S`, `AE`, `Z`, `E`, `O`) drive the tax breakdown and exemption codes.
2. `generateInvoicePDF()` calls `buildInvoiceContext(pdfDoc)` to assemble a shared `ctx` (seller, buyer, totals, fonts, formatters, `tInvoice` for invoice-language strings, `countryName`), then dispatches to the layout renderer chosen via `LAYOUT_KEY`.
3. `makeDrawKit(pdfDoc, fonts, opts)` is **exported from `main.js` and imported by `layouts.js`** (circular import — intentional). It returns the per-page drawing API (`drawText`, `drawTextRight`, `drawTextCenter`, `drawRule`, `wrapText`, `widthAt`, plus `page` getter and constants) that all three renderers rely on. Renderers must call `kit = makeDrawKit(...)` per invoice; the `page` getter is what lets them add additional pages.
4. `embedFacturXIntoPDF(pdfDoc, xml)` attaches the XML as `factur-x.xml` with `AFRelationship.Alternative`, sets PDF metadata, then calls `addPDFAOutputIntent` (sRGB ICC) and `injectFacturXMP` (PDF/A-3 + Factur-X XMP). `setPDFTrailerID` finalizes a deterministic file ID. These steps together are what makes the PDF pass verapdf — don't skip any of them.

### Font loading

pdf-lib expects SFNT/TTF, but the embedded fonts are WOFF. `woffToSfnt()` in `main.js` is a hand-rolled WOFF1→SFNT decoder that uses `pako.inflate` for compressed tables. If a font fails to decode, the loader falls back to pdf-lib's built-in Courier (always available, no network). The `_fontDataCache` keys by font id so repeated PDF generation doesn't re-decode.

### i18n

Three UI languages (`de`, `en`, `fr`) and three invoice languages (independent of UI). `t(key)` resolves UI strings; `tInvoice(key)` resolves PDF/XML strings using the invoice language. The dictionary is `I18N` near the top of `main.js`. Default boilerplate texts (intro, payment note, greeting, signature, footnote) are **stored per invoice language** — when adding a new default text, wire it into the per-language storage shape, not a single field.

### History, statistics, YoY

History snapshots are capped at `HISTORY_LIMIT = 1000`, newest first, dropped FIFO. The statistics modal groups by currency (no FX conversion — multi-currency invoices stay in separate blocks intentionally). The YoY overlay can be backfilled manually via `yoyData` when history doesn't reach back a full year. The backup JSON export/import covers all `erechnung:*` keys including history and YoY — when adding a new persisted key, extend the backup migration.

## Conventions worth respecting

- New `localStorage` keys: namespace `erechnung:<name>:v1` and add to the backup export/import path in the "Backup" section of `main.js`.
- New translatable strings: add a key to all three languages in `I18N` and reference via `data-i18n` in `index.html` or `t()` / `tInvoice()` in JS. Don't hardcode user-visible English.
- New layout: register in `LAYOUTS` in `layouts.js` and implement a renderer using `makeDrawKit(pdfDoc, fonts, opts)`. Use the shared helpers for address blocks, justified paragraphs, item pagination, and the centered bank footer to keep layouts visually consistent.
- The README is rendered inside the app's Help modal via `renderMarkdown()` in `main.js` — it's a tiny subset of Markdown, not a full parser. Test help rendering after non-trivial README edits.
- Don't reach for new runtime dependencies. The whole point is the small, offline, single-file artifact.
