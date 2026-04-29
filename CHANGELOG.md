## [1.3.0] — 2026-04-29

Adds invoice history with cloning and a statistics modal. The biggest
practical change: any generated invoice is now saved to a local
history, and a single click reconstructs it as the basis for the next
one. A new statistics view summarizes everything you've billed, broken
down per currency.

### Added

- **Invoice history.** Each generated PDF automatically writes a
  snapshot of the form (seller, buyer, items, totals, layout, font,
  language, etc.) to `localStorage` under a new key
  `erechnung:history:v1`. Hard cap of 1000 entries, oldest dropped
  first. New section in the UI between Buyer and Invoice with:
  - A picker showing each entry as `Number · Date · Buyer · Total`.
  - **Clone** — restores the entry's full state into the form. Date
    fields are intentionally left empty (you fill them deliberately);
    the invoice number is auto-assigned to the next available one;
    the buyer is overwritten with the snapshot's buyer.
  - **Delete entry** — removes a single record.
  - **Delete all** — clears the history with a confirmation.
  - **Save invoices to history** opt-out toggle stored in
    `erechnung:history_enabled:v1`. When off, new invoices are not
    saved, but existing entries stay accessible.
- **Statistics modal.** A new button in the top bar opens a per-currency
  KPI dashboard computed from the history:
  - Gross total, net, VAT, average per invoice.
  - 12-month bar chart of monthly volume (inline SVG, no chart library).
  - Top 3 buyers per currency with share %.
  - Period filter: last 30 days, last 3 months, current year, last 12
    months, all time.
  - Multi-currency invoices (EUR / USD / GBP / CHF) are shown in
    separate blocks rather than aggregated, since this tool runs
    offline and can't pull live FX rates honestly.
- **Last-invoice hint under the buyer picker.** When a saved buyer is
  selected (or typed by name), a small caption shows when the last
  invoice to that buyer was, with its number and total. Localized in
  three flavors: today / yesterday / N days ago.
- **`{layout}` filename token** — was already added in 1.1.0 but the
  `chip_layout` button in the filename chips row is now wired and
  documented.

### Changed

- **Snapshot of seller and currency** at PDF generation time, not at
  cloning time. If you change your master data later, old history
  entries still reflect the seller info that was used when the invoice
  was actually issued.
- **`buildHistorySnapshot`** reads the actual currency from
  `$('r_currency')` instead of hardcoding `EUR`. The fix also flows
  through the history picker and statistics so non-EUR amounts display
  with the correct symbol.
- **Backup format bumped to v3.** `exportData` now includes `history`
  and `history_enabled`. Status messages on export and import include a
  history count.
- **Backup import is backward compatible.** Importing a v2 backup (no
  history fields) leaves the existing history untouched rather than
  wiping it.
- **`renderHistoryPicker` and `updateBuyerHistoryHint`** are called from
  `applyTranslations`, so the picker label format and the hint phrasing
  update on UI-language switch without reloading.
- **Statistics modal re-renders on UI-language switch** while it's
  open, so KPI labels, period chips, top-buyers heading and chart
  month abbreviations update live.
- **`updateBuyerHistoryHint` runs at the end of `init()`**, so the hint
  appears immediately when the page loads with a buyer already in the
  form.

### Fixed

- **History toggle layout** in the UI used a custom class that
  collided with the global `label { display: flex; flex-direction:
  column }` rule, stacking the checkbox above its label. Now uses the
  existing `label.inline` class, with a specific override for the
  checkbox to avoid `.input-with-action input { flex: 1 }` stretching
  it across the row.
- **Statistics modal originally invisible** because the appended CSS
  block sat inside an unclosed `@media print { ... }` rule, which made
  every modal/stats/buyer-hint selector apply only when printing. The
  print block is now correctly closed before the new rules.
- **`.modal-content` background** referenced an undefined CSS variable
  (`--bg`); it now uses the actual project variable (`--paper`),
  fixing the see-through modal content area.
- **Stats button HTML markup** had a misnested `</div>` inside the
  `<button>` tag in earlier drafts of the integration; index.html
  re-ordered so the modal sits before the `<script type="module">`,
  preventing a silent listener-registration crash.
