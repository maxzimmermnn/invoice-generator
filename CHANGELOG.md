## [1.5.0] - 2026-05-05

A large release that pulls statistics and history into proper modals,
adds year-over-year comparisons, drill-down per buyer, quarterly tax
breakdowns, CSV export, and a sticky action bar. The main page is
calmer and faster to scan; advanced features moved into modals
reachable from a refreshed top bar.

### Added

- **Year-over-year comparison.** Toggle in the statistics modal header
  enables YoY arrows next to all four KPIs (gross, net, VAT, average)
  and a tooltip in the monthly chart. Comparison windows match the
  current period: YTD vs. same span last year, last 3 months vs. same
  3 months last year, and so on. Persistent setting per browser.
- **YoY backfill modal.** When you only have invoices for the current
  year in the history, you can manually enter the monthly totals from
  the previous year (per currency) so the YoY arrows have something to
  compare against. History always wins over backfill for any month
  that has actual invoices.
- **Quarterly tax breakdown.** A new Quarters tab in the statistics
  modal shows Q1–Q4 totals with columns adapted to the selected tax
  mode (S, AE, Z, E, O). Year selector to flip through past years.
  Per-currency separation kept consistent with the rest of stats.
- **Buyer drill-down.** Click a buyer in the Top Buyers list to
  replace the overview with a detail view: KPIs scoped to that buyer
  plus a chronological invoice list. Esc steps back to overview, then
  closes the modal.
- **CSV export.** A button in the statistics header exports the
  current view (overview, quarters, or drill-down) as CSV with UTF-8
  BOM and semicolon separators, ready for Excel/Numbers.
- **History modal.** The history list is now a modal opened from a
  history icon in the top bar. Cloning auto-closes the modal. Adding
  a past invoice (manual backfill) is a sub-action inside the modal.
- **Help modal with bundled README.** A `?` icon in the top bar opens
  a help modal that renders the README content directly. No external
  dependency, no internet needed.
- **Embed-XML modal.** The "embed XML in an existing PDF" workflow is
  a clearly labelled action button (and modal) instead of a mode
  toggle hidden in the output section.
- **Sticky bottom action bar.** Create PDF / XML only / Validate /
  Embed XML are always reachable as you scroll. Status messages
  appear inside the bar.
- **Multi-page PDF rendering.** Item lists that overflow a single page
  now break onto additional pages cleanly across all three layouts.

### Changed

- **Statistics period filter** now defaults to "This year" (was "Last
  30 days") and adds "Last 6 months" between "Last 12 months" and
  "Last 3 months". Order is now longest-to-shortest: this year → last
  12 months → last 6 months → last 3 months → last 30 days → all
  time. (Migrated from the [Unreleased] section in the previous
  CHANGELOG.)
- **Top bar redesigned.** Four icons (history, statistics, help, plus
  the existing language and theme controls), grouped into two visual
  clusters: settings (language + theme) and modal triggers (history
  + stats + help). Statistics icon is now a recognisable bar chart.
  History icon is a circular arrow with an inset clock.
- **Section hierarchy.** Buyer / Invoice / Items are visually
  primary (heavy top rule, large serif heading). Seller and Filename
  are visually secondary (light rule, small caps mono heading), since
  they are configured once and rarely touched after.
- **Seller section collapses by default** once master data is filled
  in, showing a one-line summary like `Acme GmbH · DE12345 · DE`.
  Click to expand. State persists.
- **Footer is one slim line:** disclaimer left, backup links right.
  The compliance/standards block was moved into the help modal where
  it is easier to read in context.
- **Backup format bumped to v4.** Adds `yoy_data` and `yoy_enabled`
  fields. v1, v2, and v3 backups still import correctly.

### Fixed

- **Statistics modal CSS scope.** Several appended blocks lived
  inside an unclosed `@media print` rule, so modal/stats/buyer-hint
  CSS only applied while printing. The print block is now correctly
  scoped and consolidated at the bottom of `styles.css`.
- **Double rule between header and first section.** Header had
  `border-bottom`, first section had `border-top`, both rendered as
  parallel lines with the section gap between them. The first
  section now drops its top border so only the header rule shows.
- **`.modal-content` background variable.** Switched from
  non-existent `--bg` to `--paper`.
- **`Last 30 days` and `Last 3 months` filters** were missing i18n
  keys and case branches in `filterByPeriod` in some builds, falling
  through to "all time" silently. Both work as advertised now.
- **Chart hover tooltip** is reliable across browsers. Replaced the
  SVG `<title>` approach with a JS-driven tooltip plus full-slot
  transparent hitboxes, so the tooltip appears even when the cursor
  is between bars.
- **`.top-stats-btn` styling regression** has become moot — the top
  bar buttons share a single `.top-icon-btn` class with consistent
  sizing and hover/active states.

### Removed

- **`.intro` block** on the main page (introductory paragraph and
  alt-text). Content moved into the help modal.
- **Output section** with mode-toggle (generate / upload). Replaced
  by the explicit Embed-XML action button + modal.
- **Inline `footer_main` paragraph** with compliance text. Same
  content lives in the help modal now.
- Dead CSS classes: `.intro*`, `.mode-toggle`, `.mode-btn`,
  `.top-stats-btn`, `.past-grid`, `.modal-actions`,
  `.noscript-warning`, `.yoy-modal-intro`. Dead JS functions:
  `applySeller`, `persistCurrentBoilerplateInMemory`.

### Internal

- `styles.css` reorganised into 18 numbered sections with all
  `@media` blocks consolidated and the spacing scale (`--gap-1` to
  `--gap-6`) plus YoY arrow colours promoted to CSS variables in
  `:root`. From 1854 lines / 187 KB to 1446 lines / 32 KB without
  visual changes.
- `main.js` section headers normalised; misleading "YoY computation"
  header (which actually housed the entire stats engine) renamed.
- `index.html` cleaned up: indentation fixed in the header,
  per-modal section comments slimmed, ARIA labels added to the
  buyer and history pickers.
- 21 new i18n keys in DE / EN / FR for the new modals, buttons, and
  status messages. Disclaimer text shortened to a single line in all
  three languages.
