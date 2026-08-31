# Insights responsive review — 2026-08-31

Reviewed the running Console at 375 × 813, 768 × 900, and 1280 × 960 CSS pixels in the in-app browser. The mobile and tablet review covered Overview, its selected-bundle inspector and picker, all Events, matching installations, a selected installation with applied/recovered events, and the no-match state. This is a UI review, not a scalability approval.

## Verified changes

- The Overview footer stays stacked until `lg`, preserving the complete local time and UTC disclosure at 768px with the sidebar open. Before the fix its timestamp exceeded a 114px cell; afterward the cell is 422px wide. [InsightsOverview.tsx:160](../../packages/console/src/components/features/insights/InsightsOverview.tsx#L160)
- The two-column bundle metric rows now share baselines, with no unmatched lower border. The measured label tops are 558px/558px and 663px/663px. [UpdateOutcomes.tsx:105](../../packages/console/src/components/features/insights/UpdateOutcomes.tsx#L105)
- Installation history places its count beside the title, eliminating “1 events” and the crowded action group. Refresh uses the same icon and size as Events. Long user IDs wrap in the metadata; table time/app/bundle text uses the same density as Events. [InstallationHistoryCard.tsx:82](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L82), [metadata:137](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L137), [table:195](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L195)
- The empty bundle chart uses “No bundle changes” and names the selected 24-hour, 7-day, or 30-day window. [BundleActivityChart.tsx:102](../../packages/console/src/components/features/bundles/BundleActivityChart.tsx#L102)
- Empty bundle searches explain how to try again, and matching rows respect reduced-motion preferences. [BundleSelector.tsx:96](../../packages/console/src/components/features/insights/BundleSelector.tsx#L96), [InstallationMatchesCard.tsx:80](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L80)
- The shared picker clear button now has the accessible name “Clear selection”. [combobox.tsx:42](../../packages/console/src/components/ui/combobox.tsx#L42)

The agreed vocabulary and presentation remain intact: **Activity reported** is neutral, applied/adopted events use success, and recovery uses warning, all with text and icons. The input reads **User ID or install ID** and the Events column reads **User ID / install ID**. Times use `YYYY/MM/DD HH:mm:ss` with the browser's named zone; opening a timestamp revealed `2026-07-16 12:00:00.000 UTC`. Keyboard Enter copied the complete seeded install ID rather than the shortened display. [EventDetails.tsx:16](../../packages/console/src/components/features/insights/EventDetails.tsx#L16), [time:59](../../packages/console/src/components/features/insights/EventDetails.tsx#L59)

## StyleSeed score

Scores use the seven-category StyleSeed rubric. The Console's specified 4px grid, Mira radius scale, and required semantic status colors take precedence over generic rubric defaults. A score of 100 means no additional rubric deduction was supported by this review; it is not an accessibility certification.

| Rendered component/file | Score | Exact remaining deduction |
| --- | ---: | --- |
| InsightsPageHeader | 100 / A | None; native navigation and current-page state. |
| InsightsControls | 100 / A | None; consistent labeled period controls. |
| InsightsOverview | 100 / A | None after the footer fix. |
| ActivityChart | 100 / A | None; named chart, empty explanation, exact table equivalent. |
| UpdateOutcomes | 100 / A | None after the metric alignment fix. |
| BundleSelector | 100 / A | States −4 resolved: empty search now suggests another bundle ID or description. [line 96](../../packages/console/src/components/features/insights/BundleSelector.tsx#L96) |
| BundleActivityChart | 100 / A | UX writing −2 resolved: empty wording now refers to bundle changes. [line 102](../../packages/console/src/components/features/bundles/BundleActivityChart.tsx#L102) |
| EventHistoryCard | 100 / A | None; explicit loading/error/empty states and refresh. |
| EventDetails | 100 / A | None; shared time, status, and bundle presentation. |
| InstallationPageHeader | 100 / A | None; named lookup, Enter submission, clear action. |
| InstallationMatchesCard | 100 / A | Motion −3 resolved: matching rows use `motion-reduce:transition-none`. [line 80](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L80) |
| InstallationHistoryCard | 100 / A | None after header and metadata fixes. |
| InstallationPagination | 100 / A | None; named paging region and disabled boundary actions. |
| InsightsErrorAlert | 100 / A | None; semantic alert with recovery copy. |

The previously lowest component, **BundleSelector, now scores 100/100**: coherence 20/20; color 16/16; hierarchy 16/16; layout 12/12; states 12/12; writing 12/12; motion 12/12. Its recovery guidance (+4), matching-row reduced-motion handling (+3), and bundle-chart wording (+2) were all completed. No further rubric deductions were supported by this review; all inspected components clear the 80-point gate. The limits below remain material despite the rubric score.

## Verification and limits

- Document width equaled viewport width on every inspected page at 375px and 768px. At 375px the Events table intentionally remains 928px wide inside its 349px container; a 390px horizontal scroll revealed the user/app columns without moving the page. Mobile screenshots therefore show only part of the table at once. At 1280px the table and its container both measured 974px.
- Final focused verification passed **6 test files / 28 tests**: installation history, Overview, selected-bundle outcomes, Insights controls, bundle chart, and the installations route. This includes Events loading/error/empty behavior, exact UTC and browser-zone handling, selected-history retry behavior, and all three empty-chart periods. [history retry scenario](../../packages/console/src/components/features/insights/InstallationHistoryCard.spec.tsx#L95), [period cases](../../packages/console/src/components/features/bundles/BundleActivityChart.spec.tsx#L30)
- Loading and error states were checked through the existing/component tests and source, not by forcing backend failures in the browser. Overview and no-match empty states were inspected live. The seeded Events list contains 18 July records, so recent-period Overview values are zero; nonzero chart values remain covered by component tests.
- Captures use the current dark theme and include development-tool launchers. Browser JPEG captures were re-encoded as PNG; no cropping, resizing, or retouching. All nine PNG files retain the original dimensions, and SHA-256 comparisons of decoded RGB pixels were identical before and after conversion. Original JPEG captures are preserved locally in `/tmp/hot-updater-insights-browser-jpeg`. This pass did not perform a formal contrast audit, screen-reader session, or an independent 200% browser-zoom test.
- The 50,000-record aggregate scan limit is still a product/backend constraint. Installation lookup does not bypass it. These screenshots do not establish support for 50,000 MAU or remove that limit.

## Screenshot evidence

| View | 375px phone | 768px tablet |
| --- | --- | --- |
| Overview | [Phone](../public/docs/console/insights-overview-mobile.png) | [Tablet footer and selected bundle](../public/docs/console/insights-overview-tablet.png) |
| Events | [Phone](../public/docs/console/insights-events-mobile.png) | [Tablet](../public/docs/console/insights-events-tablet.png) |
| Installation history | [Phone](../public/docs/console/insights-installation-mobile.png) | [Tablet](../public/docs/console/insights-installation-tablet.png) |

The existing 1280px evidence files were also refreshed: [Overview](../public/docs/console/insights-events-entry.png) and [Events](../public/docs/console/insights-event-history.png).

The final search recovery guidance is shown in the [375px empty bundle picker](../public/docs/console/insights-bundle-picker-empty-mobile.png).
