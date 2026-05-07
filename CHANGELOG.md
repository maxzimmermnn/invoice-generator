## [1.5.2] - 2026-05-07

Patch release. Typewriter layout text justification and a thorough
refresh of the bundled help text.

### Added

- **Justified body text in the Typewriter layout.** The intro,
  footnote, and payment note now render with full justification: each
  line is stretched so its words exactly fill the content width.
  The last line of each paragraph stays left-aligned, as do
  single-word lines, to avoid ugly gap distribution. Modern and
  DIN 5008 layouts are unchanged.

### Changed

- **Help modal content brought up to date with v1.5.0 / v1.5.1.**
  The bundled README text inside the help modal was last touched
  before the major v1.5.0 release and was missing several features
  and contained a few factual errors.

  Added: Embed-XML modal description, all three statistics tabs
  (Overview / Quarters / Buyer drill-down), period filter options,
  YoY toggle and backfill, CSV export, buyer reference / Leitweg-ID
  (BT-10), seller-section collapse-and-summary behaviour, layout
  descriptions matching the README.

  Fixed: font count corrected from four to five (Space Mono was
  missing), due-date chip list corrected to +14 / +30 / +60 (the
  previous text claimed five chips including "today" and "+7"
  which never existed), filename-pattern token list expanded to
  document the date-and-counter family (\`{yyyy}\`, \`{counter:N}\`,
  etc.).

### Internal

- New shared helper \`drawJustifiedLines\` in \`layouts.js\` that
  takes pre-wrapped lines, splits them into words, measures word
  widths via \`widthAt\`, and distributes the remaining horizontal
  space evenly between word gaps. Available to all layouts; only
  Typewriter uses it currently.
