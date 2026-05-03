## [1.4.0] - 2026-04-29

Adds a way to backfill the invoice history with invoices generated
elsewhere (or before adopting the tool), so the statistics view can
cover a complete period from day one.

### Added

- **Add past invoice** button in the history section. Opens a modal
  with a small form for the minimal fields needed for statistics:
  date, buyer (selectable from existing customers or free text), gross
  total, currency, tax mode, VAT rate (when applicable), plus optional
  invoice number, project and category. The entry is saved straight
  to history and counts in all statistics blocks just like a generated
  invoice.
- **`imported: true` flag** on snapshots that came from manual entry,
  used to surface a `(manual)` marker in the history picker and to
  switch the clone status message to "partial data".
- **Multi-modal Esc handling.** Pressing Esc now closes either the
  statistics modal or the past-invoice modal, whichever is open.

### Changed

- **Cloning an imported entry** loads the available data (buyer,
  currency, tax mode, project, category, plus a single synthesized
  line item that sums to the original gross total) and shows a
  status message that flags the partial nature, so it's clear why
  some fields are empty.
- **Statistics math is unchanged**, but importing an invoice with a
  standard VAT rate now correctly contributes to the net and VAT
  totals: the modal computes `net = gross / (1 + rate/100)` and stores
  it on the synthesized line item, so `computeKPIs` derives the same
  values it would for a generated invoice.
