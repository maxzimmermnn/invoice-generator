## [1.6.0] - 2026-05-12

Code-review sweep across the whole codebase. Tightens EN 16931 / PDF/A-3
compliance in places where strict validators disagreed with the previous
output, makes the storage layer surface failures instead of swallowing
them, and fixes a clutch of locale + timezone bugs that affected users
outside the original DE-seller / FR-buyer happy path. Backup format
bumped to v5 (forward-compatible — older backups still import).

### Added

- **Backup now covers history, history-toggle, number pattern, UI
  language, invoice language, and theme.** Previously `export → clear
  localStorage → import` silently lost every past invoice. Older
  backups missing the new fields still import — the missing sections
  leave existing values untouched.
- **Backup import validates every section against its expected
  shape.** Malformed entries are filtered or skipped with a console
  breadcrumb instead of corrupting state. Arrays (buyers, footnotes,
  history) are filtered entry-by-entry, so a single bad row never
  loses the rest.
- **IBAN validation in the XML validator.** When the seller IBAN is
  set but malformed (length out of range, bad checksum, non-alpha
  characters), the validator flags it with the BT-84 reference.
  Leaving the IBAN blank is still fine — the XML then emits
  payment-means type 1 instead of SEPA.
- **Localized PDF metadata.** The Title, Subject, Producer, and
  Creator fields in the PDF Info dictionary now follow the invoice
  language. PDF viewers show "Invoice 2026-00357" for EN users,
  "Facture …" for FR, "Rechnung …" for DE.
- **Full Dublin Core / XMP basic schema in the XMP packet.**
  `dc:title`, `dc:creator`, `xmp:CreateDate`, `xmp:ModifyDate`, and
  `pdf:Producer` are now emitted in addition to the Factur-X extension
  schema, so strict verapdf PDF/A-3 modes that look for these fields
  in XMP (not just in the legacy Info dictionary) accept the output.
- **Localized XML validator output.** Previously the checklist
  messages (`Rechnungsnummer fehlt`, `Verkäufer-Land fehlt`, etc.)
  were hardcoded German and confused EN/FR users running validation.
  All twelve messages plus the parser-error prefix now route through
  `t()` with explicit BT-number references (BT-1, BT-2, BT-27, …).
- **Reusable storage-key migration helper.** A small synchronous shim
  centralizes the `:v1 → :v2` pattern so future schema bumps follow a
  documented path instead of orphaning user data.

### Changed

- **Tax-per-category amount follows EN 16931 BR-CO-17.** The XML now
  emits `round(basis × rate / 100)` per VAT group instead of the
  per-line accumulation it used before. On most invoices the result
  is identical; on edge cases with sub-cent line prices the category
  tax may shift by one cent (the spec-mandated value).
- **On-screen totals are now self-consistent with line totals.**
  `calcTotals` rounds per line and accumulates, matching the per-line
  rounding the XML already used. Previously a three-line invoice of
  10.005 × 1 @ 19 % would show net = 30.02 in the UI but the per-line
  display would sum to 30.03; now both read 30.03.
- **Reverse charge requires a Seller and Buyer VAT ID.** SIRET (or
  any non-VAT legal-registration ID) is no longer accepted as a
  substitute. Per BR-AE-02 / BR-AE-04, only a VAT identifier
  (optionally a tax representative VAT ID) qualifies on the seller
  side, and a Buyer VAT ID is required outright. The validator
  message now states this explicitly with BT-31 / BT-48 references.
  Users currently relying on the SIRET fallback need to add a VAT ID
  before generating AE-mode invoices.
- **Storage keys `erechnung:lang`, `erechnung:invoice_lang`,
  `erechnung:theme` renamed to include the `:v1` suffix** used by
  every other key in the app. Migration runs once on first load and
  is transparent — existing language and theme preferences carry over.
- **Backup format version bumped to v5** to reflect the new fields.
  v4 and older backups still import; the new fields stay at their
  defaults when absent.
- **XML validator detects parser errors across all browsers.**
  Switched from `querySelector('parsererror')` to
  `getElementsByTagName('parsererror')[0]` so Firefox's
  namespace-prefixed parser error node is no longer missed.
- **Invoice-number counter only advances on pattern conformance.**
  Previously the counter was set from the rightmost numeric run in
  the typed number, so an invoice numbered `INV-2026-00042-V2` reset
  the counter to 2. The counter now updates only when the typed
  number structurally matches the saved pattern.
- **YoY backfill input accepts both German and English number
  formats.** Inputs like `1.234,56`, `1,234.56`, `1234,56`,
  `1234.56`, and bare integers all parse correctly. Previously
  thousand-separated values silently truncated to the integer before
  the first separator.
- **Markdown links in the help modal reject unsafe URL schemes.**
  `javascript:`, `data:`, `vbscript:`, `file:`, and friends collapse
  to `#`; `http(s):`, `mailto:`, `tel:`, anchors, and relative paths
  pass through. Today the only markdown source is the bundled README
  — this is prophylactic against any future code path that flows
  user-controlled markdown to the renderer.
- **Error toasts auto-hide after 7 seconds.** Previously errors
  stayed in the status bar until silently replaced by the next
  success flash, which was indistinguishable from the error never
  having occurred.

### Fixed

- **Embed-XML modal: success path threw, history was never
  recorded.** Clicking "Generate PDF" in the embed flow downloaded
  the PDF correctly but a `ReferenceError` on a non-existent
  `saveHistorySnapshot()` call landed in the catch block, flashing a
  failure message and dropping the would-be history entry.
- **Statistics and YoY no longer bucket invoices by UTC midnight.**
  `new Date('2025-01-01')` parsed as UTC midnight while
  `.getFullYear()/.getMonth()/.getDate()` returned local components,
  so users in negative UTC offsets (Americas) saw New Year's Day
  invoices bucketed into the previous year. All 23 affected call
  sites now share a `parseInvoiceDate(iso)` helper that constructs
  the Date at local midnight. Fixes quarterly tax breakdowns, monthly
  chart bars, YoY backfill matching, the period filters, and the
  picker date display.
- **`<LineTotalAmount>` header and `<BasisAmount>` totals now agree.**
  On invoices with sub-cent line prices, the header monetary
  summation (rounded once at the end of `calcTotals`) could disagree
  with the sum of `<BasisAmount>` values (each line rounded
  individually). Both now use per-line rounding, which is also what
  per-line `<LineTotalAmount>` already did.
- **Numeric item inputs no longer flicker totals to zero between
  keystrokes.** Switching `parseFloat(value) || 0` for
  `el.valueAsNumber` with a `Number.isFinite` guard means the model
  isn't reset to 0 while the user is mid-edit. A change/blur listener
  commits an empty field as 0 so cleared inputs don't carry the
  previous value into the next PDF.
- **Duplicate i18n keys cleaned up.** Each of the three language
  dictionaries declared `th_desc`/`th_qty`/`th_price` and eight
  `past_*` keys twice, with the second occurrence silently
  overriding the first. Editing the dead first occurrence had no
  effect — that landmine is gone.
- **localStorage failures surface to the user.** Persisting history,
  YoY data, or the history-enabled flag now flashes
  `msg_save_failed` when storage refuses the write (typically
  `QuotaExceededError`). Read failures (corrupted JSON entries) leave
  a `console.warn` breadcrumb so the lost data is discoverable in
  devtools.
- **Help modal markdown links carry a sane allowlist.** See above
  under Changed.

### Internal

- 11 new helpers extracted from inline code (`parseInvoiceDate`,
  `parseMoneyInput`, `isPlainObject`, `isFiniteNum`, `isValidIBAN`,
  `migrateLocalStorageKey`, `sanitizeBackupPayload`,
  `patternToCounterRegex`, `isSafeHref`, `xmpEsc`, `isoDate`).
- `applyTranslations(root?)` accepts an optional scope so stats
  re-renders no longer walk the whole document.
- Duplicate `saveNumberPattern` click handler removed; the redundant
  `setTimeout(updateSuggestNumberChipPreview, 50)` was a no-op since
  the primary handler already calls the preview update inline.
- Dead `STATS_PERIODS` constant and empty
  `persistCurrentBoilerplateInMemory` function removed.
- Currency-symbol map consolidated to a single source
  (`currencySymbol()`) instead of an inline duplicate in
  `buildInvoiceContext`.

## [1.5.3] - 2026-05-07

Adds a Last-year period filter in the statistics view, year-over-year
overlay bars in the monthly chart, calendar-year chart alignment for
"This year" and "Last year", and justified body text in the Typewriter
PDF layout. No backup-format change.

### Added

- **Last-year period filter** in the statistics view. Surfaces the
  full previous calendar year (Jan 1 to Dec 31) and works as a
  comparison anchor for the YoY toggle, which then compares against
  the year before that. New entry at the end of the period dropdown
  since it is a comparative special case rather than part of the
  longest-to-shortest main sequence.
- **Year-over-year overlay bars in the monthly chart.** When the YoY
  toggle is on, each month also renders a thin outlined bar for the
  same month one year earlier, sourced from history first then YoY
  backfill. Bars are placed side-by-side at half width, with the
  current period on the left and the previous year on the right.
  Y-axis scale includes both years so the previous-year bars never
  clip. When the YoY toggle is off the chart shows only current-period
  bars regardless of period setting.
- **Justified body text in the Typewriter PDF layout.** Multi-line
  intro, footnote, and payment-note paragraphs now align flush on
  both sides. The last line of each paragraph stays left-aligned so a
  short final word doesn't get spread across the full column width.

### Changed

- **Calendar-year alignment for the chart in "This year" and "Last
  year" periods.** The chart now shows Jan–Dec of the relevant year
  instead of rolling 12 months ending in the current month, matching
  the period-filtered KPIs and the user's mental model of a
  calendar-year overview. Other periods (last 12, last 6, etc.) keep
  the rolling-12 layout.
- **Chart heading reflects the period.** Shows the current year for
  "This year", the previous year for "Last year", and "Last 12 months"
  for everything else. Was previously always "Last 12 months"
  regardless of which period was active.
- **Period dropdown order.** "Last year" sits at the end after "All
  time" so the main longest-to-shortest sequence stays intact above
  it.

### Fixed

- **YoY outline bars in the stats chart now align exactly with their
  filled counterparts.** SVG strokes are drawn centered on the path,
  which made outlined bars visually slightly larger than filled bars
  and sit half a pixel below the chart baseline. The path is now
  inset by stroke-width/2 so the outer edges of the stroke match a
  same-value filled bar's bounds exactly.
