# E-Invoice Generator

[![GitHub release](https://img.shields.io/github/v/release/maxzimmermnn/invoice-generator?sort=semver&display_name=tag)](https://github.com/maxzimmermnn/invoice-generator/releases/latest)

A self-contained, offline-first tool for creating ZUGFeRD- / Factur-X-compliant
invoices. Runs fully offline in any modern browser, doesn't store anything on
a server.

The motivation to do this came from the frustration that basically all tools that
can do this are paid. To add an XML file to a PDF and make it compliant with the
regulation did not seem too hard to tackle, so I created this. Trying to have all
the features I could ever need and some customization options.
The tool can also retrofit already existing PDFs with an XML if you'd like to
use another application and have fancy layouts and whatnot.

This is of course created with the use of AI and I am by any means not an expert
in finance so use at your own risk. The created files pass the current e-invoice
viewers as well as the pretty strict verapdf validation.

Feel free to report any issues, I will try to keep this as up to date as I can
since I use the tool myself.


---


## Short description

Open the HTML in a browser, fill in the invoice data, generate a PDF. The PDF
carries machine-readable XML data per EN 16931 (ZUGFeRD 2.3 / Factur-X 1.0,
Comfort profile) embedded inside it, making it compliant with German
e-invoicing law (§14 UStG, in force since 2025) and valid as a Factur-X
invoice for French customers. Three UI languages (German, English, French),
five fonts, three layouts, per-language storage of default texts, a live
side-by-side PDF preview on desktop, a searchable invoice history with
cloning and status pills (and the option to backfill older invoices
manually), non-blocking inline validation for IBAN/VAT/date fields, a
first-run setup wizard with demo data, and a full statistics view with
quarterly tax breakdowns, year-over-year comparison, buyer drill-down,
and CSV export.

## Layouts

- **Modern** large headline, generous whitespace, prominent total block
- **DIN 5008** German business-letter standard with recipient address
  top-left (window-envelope compatible) and a 3-column footer
- **Typewriter** centered two-column header (buyer left, seller right),
  evenly-spaced meta row, single-line bank footer

Long item lists overflow onto additional pages cleanly in all three
layouts.

## Quick start (no installation)

Download the latest `invoice-generator.html` from the
[Releases page](../../releases) and open it in a browser. That's it. The
file is self-contained and works straight from the filesystem, no web server
needed, no internet required at runtime.

The file is around 1.8 MB because pdf-lib, fontkit, five invoice fonts and
the UI assets are embedded. In return: works without internet, without
external dependencies, without any account.

---

## Features

### First-run experience
On a fresh start (empty `localStorage`), a prominent setup card guides you
to fill in the seller stammdaten before anything else. A secondary "Start
with demo data" link populates the form with a realistic DE-to-FR
reverse-charge example (placeholder IBAN with a valid mod-97 checksum so
nothing accidentally points to a real account); nothing is persisted
until you save explicitly.

Once the seller is configured, a second card appears for the
invoice-number scheme: pick the pattern (default `{yyyy}-{counter:5}`)
and the start value, with a live preview of the next number. It shows
only when neither the pattern nor the counter has ever been written,
so existing users see no change.

A `?` next to a few key fields (service date, VAT mode, IBAN) opens a
short tooltip explaining when to pick what. Tooltips close on Esc,
outside-click, or a second click on the same `?`.

### Live preview
On viewports of 1024 px or wider, a sticky preview pane on the right
shows the rendered PDF and refreshes 300 ms after the last form change.
Re-renders pause while the cursor is over the pane so you can scroll
the embedded PDF without it reloading underneath; pending updates
flush as soon as you move the cursor back to the form. The pane has
two width tiers (compact below 1400 px, roomy above) so a single-page
A4 invoice fits without inner scrolling at either size.

The preview path skips the expensive Factur-X post-processing (XML
embedding, PDF/A-3 output intent, XMP metadata, trailer ID) and
reuses the cached fonts, so updates cost milliseconds. The full
export pipeline still runs when you actually click Create PDF.

A toggle in the top bar turns the pane on or off and the choice is
remembered. Default is on for first-time visitors on wide screens;
the toggle is hidden on smaller viewports where the pane would
crowd the form. The pane stays light-themed regardless of dark mode
so the PDF rendition is always readable.

### Seller profile
Master data (address, VAT ID, IBAN, BIC, bank, optional SIRET) is stored
locally. The seller section collapses to a one-line summary
(`Company · VAT ID · Country`) once filled in, with save and reset
buttons appearing in the header row when expanded.

### Customer database
Add, select, delete customers. Selecting a saved customer fills all buyer
fields. Buyer reference / Leitweg-ID is stored as BT-10 in the XML
(required for German government clients). When you select a buyer the
tool also shows the date and amount of the most recent invoice you sent
them, so you have context without leaving the form.

The customer-name input is also backed by a memory of names from past
invoices (deduplicated, most recent first, capped at 20). Typing or
picking a known name autofills the rest of the address block when those
fields are still empty; manual entries are never overwritten.

### Invoice number with pattern
Default pattern: `{yyyy}-{counter:5}` e.g. `2026-00042`. An internal
counter increments by 1 after each invoice. Available tokens: `{yyyy}`,
`{yy}`, `{mm}`, `{dd}`, `{counter}`, `{counter:N}`. The pattern is
editable and persistent. On first run the setup wizard (see above) lets
you set the start value explicitly, which is useful if you're migrating
from another tool and want to continue an existing series.

### Date fields
- Invoice date
- Due date (with quick chips +14 / +30 / +60 days)
- Service date (required for e-invoicing)
- Service date end (optional, for date ranges; encoded as
  BillingSpecifiedPeriod in the XML)

### Tax modes
- Standard (VAT, configurable per line item)
- Reverse charge (B2B EU cross-border)
- Zero rate (0 %)
- Exempt
- Out of scope

For reverse charge, the legal note per Art. 196 of Council Directive
2006/112/EC is automatically inserted into both PDF and XML.

### Inline validation
Non-blocking checks run as you type:

- **IBAN**: structural format plus the mod-97 checksum. A mistyped digit
  shows up immediately.
- **VAT ID**: strict patterns for DE (`DE` + 9 digits) and FR (`FR` + 2
  chars + 9 digits) keyed off the neighbouring country code; a generic
  shape check for other countries.
- **Dates**: invoice date far in the future, due date before invoice
  date, delivery end before delivery start.

Failures get a red underline and a short hint span under the field. PDF
and XML generation are never blocked by these hints, so you can still
export drafts.

### Line items
Description (wraps if long), quantity, unit price, VAT rate. As many rows
as you need. Pressing Enter on the VAT field inserts a new row directly
below and jumps focus to its description. The remove button uses a
two-step inline confirm (first click turns into "delete?", second click
removes, Esc or 3 s timeout cancels) so an accidental click never wipes
a row.

### Default texts (boilerplate)
Intro, payment note, greeting, signature and footnote are stored
**per invoice language**, separately. The `{due}` placeholder in the
payment note is replaced with the actual due date at PDF time.

### Footnote presets
Frequently-used explanations can be saved as named presets and inserted
from a dropdown. If the chosen preset reads like a reverse-charge note
(matched on keywords like "reverse charge", "autoliquidation",
"Steuerschuldnerschaft"), the precise Art. 196 legal sentence is
automatically prepended in the active invoice language, unless the
citation is already present.

### Language selectors
Two independent dropdowns:
- **UI language**: the tool's interface language
- **Invoice language**: language of the generated PDF / XML

The two are independent. You can keep the UI in German and still generate
English invoices, for example.

### Fonts
Five monospace fonts for the PDF (all embedded, all with proper Bold weight):
**Courier Prime**, **IBM Plex Mono**, **JetBrains Mono**, **Inconsolata**,
**Space Mono**.

### Filename pattern
On download the filename is generated from a token pattern. Default:
`{nr}_{buyer}_{project}`. Tokens: `{nr}`, `{date}`, `{buyer}`, `{seller}`,
`{project}`, `{category}`, `{layout}`. A live preview shows the resolved
filename.

### Invoice history
A history icon in the top bar opens a modal with all generated invoices
(up to 1000 entries, oldest dropped first). Once at least one invoice
exists, a second icon in the top bar offers **Duplicate last invoice**
as a one-click shortcut (same effect as opening the modal and cloning
the topmost entry).

Inside the modal:

- A **search field** does full-text matching across invoice number,
  buyer name, formatted total, project, and category. A **period
  filter** narrows the list by time range (YTD, last 12 / 6 / 3 months,
  last 30 days, last year, all). The list updates live as you type.
- The entries render as a scrollable list (no dropdowns) with per-row
  **Clone** and **Delete** buttons. Clone restores buyer, items,
  project, category, tax mode, language, font and layout, sets the
  date to today, auto-assigns the next invoice number, and closes the
  modal. Delete uses the same two-step inline confirm as the line
  items (first click turns into "delete?", Esc or 3 s cancels).
- A **status pill** on each row distinguishes manually backfilled
  entries (neutral "Entwurf") from tool-generated invoices ("Exportiert"
  in blue). The schema reserves room for a future "paid" stage.
- **Add past invoice** to backfill older invoices generated elsewhere,
  so the statistics view can cover a complete period. A small form
  captures the minimum fields (date, buyer, total, currency, tax mode);
  these entries are flagged as Entwurf in the list.
- **Delete all** to clear the history with a confirmation prompt.
- **Save invoices to history** toggle. When off, new invoices won't be
  saved, but existing entries remain accessible.

When the history is empty, an empty-state card prompts you to create
your first invoice. When the filter narrows to zero matches, a
"Reset filters" CTA clears the search and period in one click.

History is stored in `localStorage` like everything else and is included
in the JSON backup export.

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
KPIs, a comparison bar in the chart tooltip, and a thin outlined bar
in the monthly chart for each month one year earlier. If you only have
history for the current year, a **Set previous year** button opens a
small backfill form where you enter monthly totals manually for any
past year and currency. The backfill values flow into both KPIs and
the outline bars.

Period filter on the Overview tab: this year, last 12 months, last 6
months, last 3 months, last 30 days, all time, last year. The chart
shows Jan–Dec of the relevant year for "this year" and "last year",
and rolling 12 months for everything else.

A **CSV export** button in the header dumps the current view (overview,
quarters, or buyer detail) as UTF-8 with semicolon separators, ready
for Excel/Numbers.

Multi-currency invoices are kept in separate blocks so amounts stay
honest with no offline FX guesswork.

### XML validation
The "Validate XML" button checks whether all EN 16931 mandatory fields
are populated. "Download XML only" produces just the XML file, without a PDF.

### Embed XML into existing PDF
If you already have a finished invoice PDF (e.g. designed in InDesign or
exported from another tool), the "Embed XML" button opens a modal where
you drop the PDF in and get back a ZUGFeRD-compliant version with the
XML attached. The form fields in the tool fill the XML side, the PDF
visual is whatever you uploaded.

### Backup
Export / import the entire tool state as a JSON file, including history,
buyer database, footnote presets and YoY backfill data. The migration
path handles older backup versions automatically; older backups without
history or YoY data import cleanly, leaving the existing values
untouched.

### Theme
Light / dark / auto (follows OS preference).

### Help
A `?` icon in the top bar opens a help modal that renders the README
content directly. No internet required.

---

## Compliance & standards

- **Format**: ZUGFeRD 2.3 / Factur-X 1.0
- **Profile**: EN 16931 (Comfort)  `urn:cen.eu:en16931:2017`
- **Mandatory fields**: BT-1 (invoice number), BT-2 (date), BT-3 (type 380),
  BT-5 (currency), BT-9 (due date), BT-10 (buyer reference, optional),
  seller / buyer addresses, tax breakdown, delivery date (BT-72)
- **Reverse charge**: encoded as a tax category entry with an ExemptionReason
- **PDF attachment**: XML is attached to the PDF as embedded file
  `factur-x.xml`
- **Validators**: Quba Viewer, Mustang, ELSTER E-Rechnungsviewer

---

## Privacy & offline guarantee

- **No network calls at runtime.** All libraries (pdf-lib, fontkit, pako),
  all fonts and all UI assets are embedded into the built HTML file.
- **No server component.** The file runs straight from the filesystem or
  from any static web server.
- **Local data only**: All input (including the invoice history) is
  stored in `localStorage`. Backup export produces a JSON file you
  download yourself; nothing is transmitted.

---

## For developers

The repository contains the source code. The shipped HTML in the
[Releases](../../releases) section is built from this source.

### Build from source

Requires [Node.js](https://nodejs.org/) (v20 or newer).

    npm install
    npm run build

The result is a single `dist/index.html` ready to use.

### Development

    npm run dev

Hot-reload dev server.

### Project structure

- `index.html` - markup shell
- `src/main.js` - application logic
- `src/utils.js` - shared helpers
- `src/fonts.js` - embedded invoice fonts (base64)
- `src/styles.css` - UI styling
- `src/layouts.js` - invoice layout renderers
- `vite.config.js` - Vite build config (single-file output)

## Example invoices

Three PDFs built with this tool, all showing the same fictional invoice, one per layout:

- `example_modern.pdf` - Modern layout
- `example_din5008.pdf` - DIN 5008 layout
- `example_typewriter.pdf` - Typewriter layout

---

## Credits

Embedded fonts (all licensed under the SIL Open Font License):

- [Inconsolata](https://github.com/googlefonts/Inconsolata) - UI mono / invoice option
- [Courier Prime](https://github.com/quoteunquoteapps/CourierPrime)
- [IBM Plex Mono](https://github.com/IBM/plex)
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono)
- [Space Mono](https://github.com/googlefonts/spacemono)

Libraries:
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT)
- [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) (MIT)
- [pako](https://github.com/nodeca/pako) (MIT)

---

## Disclaimer

Free, vibe-coded tool. No warranty for correctness, completeness or legal
compliance of the generated documents. Use at your own risk. Before
production use, validate with a certified validator (Quba Viewer, ELSTER)
and consult a tax advisor when in doubt.

---

## License

MIT, see [LICENSE](LICENSE).
