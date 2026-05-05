# README updates for v1.5.0

The following sections in `README.md` need updates for v1.5.0. Drop-in
replacements below — copy each block over the matching one in the
existing README.

---

## Replace the "Short description" paragraph

The current paragraph mentions "an invoice history with cloning ... plus
a statistics view". Update to reflect the expanded scope:

```markdown
## Short description

Open the HTML in a browser, fill in the invoice data, generate a PDF. The PDF
carries machine-readable XML data per EN 16931 (ZUGFeRD 2.3 / Factur-X 1.0,
Comfort profile) embedded inside it, making it compliant with German
e-invoicing law (§14 UStG, in force since 2025) and valid as a Factur-X
invoice for French customers. Three UI languages (German, English, French),
five fonts, three layouts, per-language storage of default texts, an
invoice history with cloning (and the option to backfill older invoices
manually), and a full statistics view with quarterly tax breakdowns,
year-over-year comparison, buyer drill-down, and CSV export.
```

---

## Replace the "Statistics" feature section

The existing section describes only the basic KPIs and chart. Replace the
entire `### Statistics` block with:

```markdown
### Statistics

A statistics icon in the top bar opens a modal with everything you need
to look back at your billing. For each currency separately
(EUR / USD / GBP / CHF), the **Overview** tab shows:

- Gross total, net, VAT, average per invoice
- A 12-month bar chart with hover tooltips
- Top 3 buyers, each clickable to drill down into a buyer-specific view
  with their KPIs and chronological invoice list

The **Quarters** tab shows Q1–Q4 totals with columns adapted to the tax
mode, and a year selector to flip through past years.

A **YoY toggle** in the header adds year-over-year arrows next to the
KPIs and a comparison bar in the chart tooltip. If you only have history
for the current year, a **Set previous year** button opens a small
backfill form where you enter monthly totals manually for any past year
and currency.

Period filter on the Overview tab: this year, last 12 months, last 6
months, last 3 months, last 30 days, all time.

A **CSV export** button in the header dumps the current view (overview,
quarters, or buyer detail) as UTF-8 with semicolon separators, ready
for Excel/Numbers.

Multi-currency invoices are kept in separate blocks so amounts stay
honest with no offline FX guesswork.
```

---

## Replace the "Invoice history" feature section

Update the History section to mention that it's now a modal opened from
the top bar:

```markdown
### Invoice history

A history icon in the top bar opens a modal with all generated invoices
(up to 1000 entries, oldest dropped first):

- **Clone** any past invoice back into the form. All fields including
  buyer, items, project, category, tax mode, language, font and layout
  are restored. Date fields stay empty so you fill them explicitly; the
  invoice number is auto-assigned to the next available one. Cloning
  closes the modal so you land back on the form.
- **Add past invoice** to backfill older invoices generated elsewhere,
  so the statistics view can cover a complete period. A small form
  captures the minimum fields (date, buyer, total, currency, tax mode);
  these entries are flagged as manual in the picker.
- **Delete entry** to remove a single record.
- **Delete all** to clear the history with a confirmation prompt.
- **Save invoices to history** toggle. When off, new invoices won't be
  saved, but existing entries remain accessible.

History is stored in `localStorage` like everything else and is included
in the JSON backup export.
```

---

## Add a new "Help" feature section (after Theme, before Compliance)

Insert this section between the existing **Theme** entry and the
**Compliance & standards** heading:

```markdown
### Help

A `?` icon in the top bar opens a help modal that renders the README
content directly. No internet required.
```

---

## Update the "Layouts" section

The current Layouts section describes positioning and visuals. Add a
mention of multi-page support — invoices with long item lists now
break onto additional pages cleanly across all three layouts. Insert
a short note after the bullet list:

```markdown
## Layouts

- **Modern** large headline, generous whitespace, prominent total block
- **DIN 5008** German business-letter standard with recipient address
  top-left (window-envelope compatible) and a 3-column footer
- **Typewriter** centered two-column header (buyer left, seller right),
  evenly-spaced meta row, single-line bank footer

Long item lists overflow onto additional pages cleanly in all three
layouts.
```

---

## Notes on what does NOT need to change

- **Quick start**, **Compliance & standards**, **Privacy & offline
  guarantee**, **For developers**, **Project structure**, **Example
  invoices**, **Credits**, **Disclaimer**, **License** — all still
  accurate.
- The file size note ("around 1.8 MB") is approximate and should still
  be in the right ballpark — verify after building if you want exact
  numbers.
- The Tax modes, Line items, Default texts, Footnote presets,
  Language selectors, Fonts, Filename pattern, XML validation, Backup,
  and Theme sections are unchanged in behaviour and don't need edits.
