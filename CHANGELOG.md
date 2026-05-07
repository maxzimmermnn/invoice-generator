## [1.5.3] - 2026-05-07

Adds a Last-year period filter in the statistics view, year-over-year
overlay bars in the monthly chart, calendar-year chart alignment for
"This year" and "Last year", and justified body text in the Typewriter
PDF layout. No backup-format change.

### Added

- **Last-year period filter** in the statistics view. Surfaces the
  full previous calendar year (Jan 1 to Dec 31) and works as a
  comparison anchor for the YoY toggle, which then compares against
  the year before that. New entry at the end of the period dropdown
  since it is a comparative special case rather than part of the
  longest-to-shortest main sequence.
- **Year-over-year overlay bars in the monthly chart.** When the YoY
  toggle is on, each month also renders a thin outlined bar for the
  same month one year earlier, sourced from history first then YoY
  backfill. Bars are placed side-by-side at half width, with the
  current period on the left and the previous year on the right.
  Y-axis scale includes both years so the previous-year bars never
  clip. When the YoY toggle is off the chart shows only current-period
  bars regardless of period setting.
- **Justified body text in the Typewriter PDF layout.** Multi-line
  intro, footnote, and payment-note paragraphs now align flush on
  both sides. The last line of each paragraph stays left-aligned so a
  short final word doesn't get spread across the full column width.

### Changed

- **Calendar-year alignment for the chart in "This year" and "Last
  year" periods.** The chart now shows Jan–Dec of the relevant year
  instead of rolling 12 months ending in the current month, matching
  the period-filtered KPIs and the user's mental model of a
  calendar-year overview. Other periods (last 12, last 6, etc.) keep
  the rolling-12 layout.
- **Chart heading reflects the period.** Shows the current year for
  "This year", the previous year for "Last year", and "Last 12 months"
  for everything else. Was previously always "Last 12 months"
  regardless of which period was active.
- **Period dropdown order.** "Last year" sits at the end after "All
  time" so the main longest-to-shortest sequence stays intact above
  it.

### Fixed

- **YoY outline bars in the stats chart now align exactly with their
  filled counterparts.** SVG strokes are drawn centered on the path,
  which made outlined bars visually slightly larger than filled bars
  and sit half a pixel below the chart baseline. The path is now
  inset by stroke-width/2 so the outer edges of the stroke match a
  same-value filled bar's bounds exactly.
