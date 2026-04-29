## [1.2.0] — 2026-04-29

This release adds a third invoice layout, completes the i18n sweep across
the PDF renderers, and consolidates duplicated logic in `layouts.js` into
shared helpers.

### Added

- **Typewriter layout.** A third option in the layout dropdown, alongside
  Modern and DIN 5008. Centered monospace look with a two-column
  buyer/seller header, a meta row (No. / Date / Service), and a
  single-line bank footer.
- **Two new i18n keys** (in `main.js`, used by `layouts.js`):
  - `pdf_invoice_label` — `RECHNUNG` / `INVOICE` / `FACTURE`
  - `pdf_vat_id_label` — `USt-IdNr.` / `VAT No.` / `N° TVA`

### Changed

- **PDF output now respects the invoice language across all layouts.**
  Hardcoded German and English strings in the renderers were replaced with
  i18n lookups:
  - DIN 5008's `Rechnung` subject-fallback → `tI('pdf_invoice_label')`
  - DIN 5008's `USt-IdNr.` (two places: info block, footer column) →
    `tI('pdf_vat_id_label')`
  - Modern's `INVOICE` top label → `tI('pdf_invoice_label')`
  - Modern's `VAT` totals label → `tI('total_tax_S')`
- **Data labels are now consistent across Modern and Typewriter.** All
  inline labels in both layouts use the colon-separated form: `VAT: 123`,
  `SIRET: 456`, `Ref: 789`, `IBAN: ...`, `BIC: ...`. Modern previously
  rendered these without colons; Typewriter had an internal inconsistency
  (`VAT No.:` for the seller, `VAT:` everywhere else) which is now
  uniform `VAT:`.
- **Bank-line separator unified.** Modern and Typewriter both use a
  mid-dot (` · `) by default in `drawCenteredBankLine`. Typewriter
  previously used hyphens (` - `).
- **Address field order canonicalised** between Modern and Typewriter.
  Both now use the same order: `line1, zip+city, country, [email,
  phone], VAT, SIRET, [reference]`. Typewriter previously rendered SIRET
  before VAT and phone before email.
- **`layouts.js` deduplicated via three shared helpers:**
  - `shrinkToFit(text, font, maxWidth, widthAt, start, min, step)` —
    replaces four inline `while (widthAt(...) > max && size > floor)
    size -= 0.25` loops in DIN 5008 and the Modern/Typewriter footers.
  - `formatPartyAddress(party, cn, opts)` — builds the address line
    array used by Modern and Typewriter from a single source.
  - `drawCenteredBankLine(seller, kit, opts)` — wraps the
    name/bank/IBAN/BIC join + auto-shrink + centered draw used by
    Modern and Typewriter.
- **DIN 5008 recipient block** rewritten as an array + loop instead of
  four inline `if` statements. Postal-format logic (uppercase country
  only when buyer is in a different country than seller) is preserved.

### Fixed

- **Dead i18n fallbacks removed** from `layouts.js`. Three `||`
  fallbacks (`tI('th_desc') || 'Beschreibung'` in DIN 5008,
  `tI('th_desc') || 'Description'` in Modern, `tI('pdf_payment') ||
  'PAYMENT'` in Modern) were unreachable since the corresponding keys
  exist in all three languages after the v1.1.0 i18n sweep. They also
  documented an old DE/EN inconsistency for `th_desc`.
- **Indentation** of the `if (intro) { ... }` blocks in DIN 5008 and
  Modern. Previously sat at zero indent inside the function body.

### Removed

- **Unused imports** from `layouts.js`: `rgb` (from `pdf-lib`) and
  `countryName` (from `./main.js`). Renderers use `ctx.countryName`
  via destructuring instead.
- **Unused destructured variables** in all three renderers: `INK`,
  `currency`, `due`. `currencySym` is kept (used in Typewriter's VAT
  line).
