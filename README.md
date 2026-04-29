# E-Invoice Generator

A self-contained, offline-first tool for creating ZUGFeRD- / Factur-X-compliant
invoices. Runs fully offline in any modern browser, doesn't store anything on
a server. 

The motivation to do this came from the frustration that basically all tool that
can do this are paid. To add a xml file to a pdf and make it compliant with the 
regulation did not seem to hard to tackle, so I created this. Trying to have all
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
five fonts, three layouts, per-language storage of default texts, an
invoice history with cloning and a statistics view.

## Layouts

- **Modern** large headline, generous whitespace, prominent total block
- **DIN 5008** German business-letter standard with recipient address
  top-left (window-envelope compatible) and a 3-column footer
- **Typewriter** centered two-column header (buyer left, seller right),
  evenly-spaced meta row, single-line bank footer

## Quick start (no installation)

Download the latest `invoice-generator.html` from the
[Releases page](../../releases) and open it in a browser. That's it. The
file is self-contained and works straight from the filesystem, no web server
needed, no internet required at runtime.

The file is around 1.8 MB because pdf-lib, fontkit, five invoice fonts and
two UI fonts are embedded. In return: works without internet, without
external dependencies, without any account.

---

## Features

### Seller profile
Master data (address, VAT ID, IBAN, BIC, bank, optional SIRET) is stored
locally. A reset button clears everything.

### Customer database
Add, select, delete customers. Selecting a saved customer fills all buyer
fields. Buyer reference / Leitweg-ID is stored as BT-10 in the XML
(required for German government clients). When you select a buyer the
tool also shows the date and amount of the most recent invoice you sent
them, so you have context without leaving the form.

### Invoice number with pattern
Default pattern: `{yyyy}-{counter:5}` e.g. `2026-00042`. An internal
counter increments by 1 after each invoice. Available tokens: `{yyyy}`,
`{yy}`, `{mm}`, `{dd}`, `{counter}`, `{counter:N}`. The pattern is
editable and persistent.

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

### Line items
Description (wraps if long), quantity, unit price, VAT rate. As many rows
as you need.

### Default texts (boilerplate)
Intro, payment note, greeting, signature and footnote are stored
**per invoice language**, separately. The `{due}` placeholder in the
payment note is replaced with the actual due date at PDF time.

### Footnote presets
Frequently-used explanations can be saved as named presets and inserted
from a dropdown.

### Language selectors
Two independent dropdowns:
- **UI language**: the tool's interface language
- **Invoice language**: language of the generated PDF / XML

The two are independent. you can keep the UI in German and still generate
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
Each generated invoice is automatically saved to a local history (up to
1000 entries, oldest dropped first). From the history dropdown you can:

- **Clone** any past invoice back into the form. All fields including
  the buyer, items, project, category, tax mode, language, font and
  layout are restored. Date fields stay empty so you fill them
  explicitly; the invoice number is auto-assigned to the next available
  one.
- **Delete entry** to remove a single record.
- **Delete all** to clear the history with a confirmation prompt.
- **Save invoices to history** toggle. When off, new invoices won't be
  saved, but existing entries remain accessible.

History is stored in `localStorage` like everything else and is included
in the JSON backup export.

### Statistics
A **Statistics** button in the top bar opens a modal with a quick KPI
overview computed from the history. For each currency separately
(EUR / USD / GBP / CHF):

- Gross total, net, VAT, average per invoice
- A 12-month bar chart of monthly volume
- Top 3 buyers with their share

Period filter: last 30 days, last 3 months, current year, last 12
months, all time.

Multi-currency invoices are kept in separate blocks so amounts stay
honest, with no offline FX guesswork.

### XML validation
The "Validate XML" button checks whether all EN 16931 mandatory fields
are populated. "Download XML only" produces just the XML file, without a PDF.

### Backup
Export / import the entire tool state as a JSON file, including history.
A migration path for older backup versions is built in (older backups
without history are imported and the existing history is left
untouched).

### Theme
Light / dark / auto (follows OS preference).

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

- [Fraunces](https://github.com/undercasetype/Fraunces) - UI serif
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
