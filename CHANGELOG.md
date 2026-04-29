## [1.2.1] — 2026-04-29

Patch release: `README.md` catches up with the v1.2.0 layout additions,
plus small visual fixes to the DIN 5008 totals block and the Typewriter
intro paragraph.

### Added

- **`examples/example_typewriter.pdf`** alongside the existing Modern
  and DIN 5008 examples. Modern and DIN 5008 example PDFs refreshed to
  reflect the v1.2.0 visual changes.

### Changed

- **`README.md`** updated to describe three layouts (was two), to add a
  Typewriter entry to the layouts list, to format the `{layout}`
  filename token consistently with the other tokens, and to add the
  Typewriter example to the example-invoices section.

### Fixed

- **DIN 5008 totals divider** sat too close to the previous subtotal
  row, visually pushing it against the grand-total text. Now sits
  exactly one `LINE` below the subtotal/VAT row and one `LINE` above
  the grand total, with adequate breathing room on both sides.
- **DIN 5008 items-end rule** now spans the full content width
  (parallel to the table's header rule) instead of the same short
  range as the totals divider, restoring the visual hierarchy:
  full-width rules frame the items table; a short rule sits inside
  the totals block.
- **Typewriter intro paragraph** now uses size 9 with `LINE_H × 0.85`
  spacing, matching Modern and DIN 5008. Previously rendered at
  `SIZE_BODY` (10.5) with full `LINE_H`, which looked oversized
  relative to the other layouts.
