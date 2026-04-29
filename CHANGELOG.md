# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — 2026-04-29

This release covers the migration from a single inline-bundled HTML file to
a Vite-based source layout, plus a code review pass over `index.html`,
`styles.css`, and `main.js`.

### Added

- **Build system: Vite + `vite-plugin-singlefile`.** Source is now split
  across `src/index.html`, `src/styles.css`, `src/main.js`, `src/fonts.js`,
  `src/utils.js`, and `src/layouts.js`. The production build still emits a
  single self-contained HTML file, runnable offline.
- **`pdf-lib`, `@pdf-lib/fontkit`, and `pako` are npm dependencies.**
  Replaces the previously inlined UMD bundles in the HTML.
- **Filename token `{layout}`.** Resolves to the currently-selected layout
  key (e.g. `modern`). The filename preview updates live when the layout
  dropdown changes. New i18n key `chip_layout` for de/en/fr.
- **Print stylesheet.** `@media print` hides interactive controls (buttons,
  toggles, drop zone, footer, status banner, line-item delete buttons) and
  forces a clean black-on-white render of the form, with
  `break-inside: avoid` on sections.
- **Keyboard focus indicators.** `:focus-visible` outlines on buttons,
  the theme toggle, the language select, footer link buttons, and the
  number-pattern `<summary>`. Inputs/selects/textareas keep their existing
  border-bottom focus style.
- **i18n coverage for previously hardcoded strings (de/en/fr):**
  - `xml_sepa_info`, `xml_payable_by` — XML output text (SEPA payment
    description, due-date description) so non-German invoices stop
    emitting German XML content.
  - `err_no_number`, `err_no_date`, `err_no_seller_name`,
    `err_no_buyer_name`, `err_no_items`, `err_country_required`,
    `err_country_unknown`, `err_rc_seller_vat`, `err_rc_buyer_vat` —
    validation errors thrown from `buildXML` and country normalization.
  - `th_desc`, `th_qty`, `th_price`, `th_vat`, `aria_remove_item` —
    line-item table column labels (visible on mobile via the
    `data-label` CSS trick) and the remove-button aria-label.

### Changed

- **Bootstrap centralised in `async function init()`.** Replaces a mix of
  scattered IIFEs, freestanding async loads, and a thenable without a
  catch. Five ordered phases: render-blocking visual state → user-editable
  defaults → layout dropdown → parallel `Promise.all` of persisted state →
  invoice number autofill. Runs under a single `init().catch()` that flashes
  errors via the status banner instead of swallowing them silently.
- **Country normalization extracted to module top-level.**
  `COUNTRY_ALIAS_MAP`, `normalizeCountry()`, and
  `validateInvoiceForReverseCharge()` were declared inside `buildXML()`
  due to mid-function indentation that hid the scoping. The frozen alias
  map was being rebuilt on every invoice render. Now defined once at
  module scope.
- **`countryName()` consolidated into the country block** with a
  module-level frozen `COUNTRY_NAMES` map. Previously lived next to
  `makeDrawKit` at the bottom of the file.
- **Storage key constants consolidated.** `THEME_KEY` lives next to
  `LANG_KEY` and `INVOICE_LANG_KEY` at the top of the storage section.
  The literal `'erechnung:theme'` previously sprinkled around now uses
  the constant. The `store` wrapper has a comment explaining why theme
  and language preferences read `localStorage` directly (sync needed at
  init to avoid a flash of the wrong theme).
- **Item IDs use `crypto.randomUUID()`.** Replaces
  `Math.random().toString(36).slice(2, 9)`.
- **`index.html`:**
  - Version label corrected (`v2.0` → `v1.0`).
  - `lang="en"` with English defaults for tag consistency.
  - Meta description and Open Graph tags added.
  - All inline `style="…"` attributes extracted into named CSS classes
    (`.top-controls`, `.intro-line`, `.intro-line-last`,
    `.input-with-action`, `.filename-chips`, `.filename-preview`,
    `.hidden`, `.visually-hidden`).
  - Two adjacent `<link>` tags split onto their own lines.
- **`<noscript>` warning relocated** to the start of `<body>` with a
  `noscript-warning` CSS class. Previously sat in `<head>` with an inline
  style.
- **CSS indentation normalized** to 2 spaces throughout `styles.css`
  (was a mix of 2 and 4 due to the original `<style>` block being
  embedded in HTML).
- **`footer p` rules consolidated** to a single `:not(:last-child)`
  selector.

### Fixed

- **`buyer.siret` was silently dropped from XML output.** `buildXML()`
  built its `buyer` object inline with seven fields, omitting `siret`,
  even though `collectBuyer()` produces it and the XML template references
  it. Replaced the inline literal with `const buyer = collectBuyer();`.
- **Reverse-charge validation now correctly accepts SIRET as a fallback
  for missing VAT ID.** Same root cause as the bug above — the buyer
  passed into `validateInvoiceForReverseCharge` was missing `siret`, so
  the `(!buyer.vat && !buyer.siret)` check effectively reduced to
  `!buyer.vat`.
- **1px layout shift when focusing a line-item cell.** `.items input,
  .items select` now reserve a `border-bottom: 1px solid transparent;`
  in the resting state, and focus only changes its color.
- **Duplicate `clearDeliveryEnd` click listener removed.** Both fired on
  every click.
- **Triple-blank-line sequences collapsed** to single blank lines (a few
  cropped up from earlier edits).

### Notes for downstream

If you have a saved filename pattern that uses `{layout}` already (you
won't, this is a new token), it now resolves to the layout key. Existing
patterns are unaffected.
