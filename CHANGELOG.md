## [1.5.1] - 2026-05-05

Patch release with UI polish based on post-release feedback. No
functional changes; same backup format as v1.5.0.

### Changed

- **Top bar reorganised into three groups.** Order is now history +
  stats on the left, language + theme in the middle, help on the
  right. Spacing between all icons is uniform (was previously
  inconsistent due to a legacy `.tiny-btn` margin that affected only
  some of the icon buttons).
- **Save / reset buttons moved into the seller header row.** They now
  sit on the right side of the SELLER toggle line, only visible when
  the section is expanded. Hides automatically when the section is
  collapsed so the summary line stays clean. The hint paragraph
  underneath is now plain explanatory text without buttons appended.
- **All headlines switched from serif to mono.** The H1, primary
  section headings (Buyer, Invoice, Items), the totals grand value,
  the help modal subheadings, the per-currency stats block headers,
  and the buyer drill-down title were previously declared as Fraunces
  serif (which fell back to the system serif since Fraunces was never
  actually loaded). They now use Inconsolata mono consistently with
  the rest of the UI.

### Fixed

- **Seller toggle vertical alignment.** The toggle text and arrow
  now sit on the same baseline as the SELLER h2 next to them. The
  previous setup mixed `align-items: baseline` on the toggle with a
  smaller font-size and vertical padding, which pushed the toggle
  text below the heading.
- **Save / reset button height in the seller header.** The default
  `.tiny-btn` line-height made these buttons taller than the
  surrounding h2; now they share a baseline thanks to a tighter
  line-height plus matching padding adjustment.
- **Header indentation in `index.html`.** The `<div class="top-controls">`
  block had inconsistent leading whitespace; reformatted to match
  the rest of the file.
