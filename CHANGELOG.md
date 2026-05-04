## [Unreleased]

### Changed

- **Statistics period filter** has a new default and an extra option:
  default is now "This year" instead of "Last 30 days", which surfaces
  meaningful data immediately for users who haven't generated invoices
  in the very recent past. Added "Last 6 months" between "Last 12
  months" and "Last 3 months". Reordered the dropdown from longest to
  shortest period (this year → last 12 → last 6 → last 3 → last 30
  days → all time).

  
## [1.4.1] - 2026-05-03

Patch release. Fixes a few rough edges in the statistics view and
restores some CSS that had drifted out of sync with the JavaScript.

### Fixed

- **`Last 30 days` and `Last 3 months` period filters** in the
  statistics modal now actually filter. The supporting i18n keys
  (`stats_period_last_month`, `stats_period_last3`) and the
  corresponding cases in `filterByPeriod` were missing in some
  builds, so picking those options either showed the raw key name
  in the dropdown or silently fell through to "all time".
- **Chart hover tooltip** is reliable now. The previous
  implementation used SVG `<title>` elements which Chrome on macOS
  shows inconsistently; replaced with a JS-driven tooltip plus
  full-slot transparent hitboxes so the tooltip appears even when
  the cursor is between bars.
- **Statistics modal CSS scope.** The appended block lived inside an
  unclosed `@media print { ... }` rule, so all modal, statistics,
  buyer-hint, past-invoice and tooltip rules applied only when the
  page was actually printed. The print block is now correctly closed
  before the rest, and the modal renders as an overlay with the
  intended backdrop.
- **`.modal-content` background** referenced a non-existent CSS
  variable (`--bg`); switched to `--paper`, restoring the visible
  content panel.
- **`.top-stats-btn` styling** restored. Without it the statistics
  button in the top bar fell back to default `.tiny-btn` shape and
  did not match the theme toggle next to it.
