# Insights responsive review — 2026-09-02

This revision responds to the repeated text and awkward mobile reading flow in
the previous review. It separates source and test evidence from browser evidence.
The previous blanket 100-point assessment and acceptance of horizontally scrolled
mobile tables are superseded. The current cursor-based backend contract is
reviewed separately in [the scale review](./insights-scale-review.md).

## Implemented hierarchy and interaction

- Overview now presents one period-aware title and one active-installation count.
  The repeated description, Active installations label, reporting-window footer,
  and Activity over time title were removed. Exact deduplication semantics remain
  accessible in the metric and chart table. [InsightsOverview.tsx:130](../../packages/console/src/components/features/insights/InsightsOverview.tsx#L130),
  [ActivityChart.tsx:127](../../packages/console/src/components/features/insights/ActivityChart.tsx#L127)
- A zero-activity period collapses to **No activity** and a direct **View events**
  link. Populated charts retain the bucket interval and UTC label without a
  second title or explanatory paragraph. [ActivityChart.tsx:59](../../packages/console/src/components/features/insights/ActivityChart.tsx#L59)
- Selected-bundle metrics use two columns on narrow screens, with compact units
  instead of repeated definitions under each value. The selector stays in its
  card header. [UpdateOutcomes.tsx:49](../../packages/console/src/components/features/insights/UpdateOutcomes.tsx#L49),
  [metric list:91](../../packages/console/src/components/features/insights/UpdateOutcomes.tsx#L91)
- Navigation, period, lookup, and paging actions are at least 44px tall below
  `lg`. Both lookup and picker search inputs use 16px text and 44px input height
  in that range. These are implementation values; browser measurements are
  recorded separately below. [navigation:15](../../packages/console/src/components/features/insights/InsightsPageHeader.tsx#L15),
  [period:37](../../packages/console/src/components/features/insights/InsightsControls.tsx#L37),
  [lookup:38](../../packages/console/src/components/features/insights/InstallationPageHeader.tsx#L38),
  [picker:89](../../packages/console/src/components/features/insights/BundleSelector.tsx#L89),
  [pagination:33](../../packages/console/src/components/features/insights/InsightsPagination.tsx#L33)
- Matching installations form a collapsed chooser below `lg`, so many matches
  cannot bury the selected history on first arrival. Selecting a match closes
  the chooser and returns focus to its trigger. Desktop keeps the sidebar open;
  errors and empty results do not collapse. **No matches** provides an **Edit
  search** action. [InstallationMatchesCard.tsx:40](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L40),
  [selection:109](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L109),
  [empty state:155](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L155)
- Event history switches by available card width: All Events below 58rem and
  installation history below 48rem use a vertical list. Status and time lead,
  followed by identity, app, and bundle values. Each field remains readable
  without horizontal table scrolling. [EventHistoryCard.tsx:154](../../packages/console/src/components/features/insights/EventHistoryCard.tsx#L154),
  [InstallationHistoryCard.tsx:172](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L172),
  [EventHistoryList.tsx:24](../../packages/console/src/components/features/insights/EventHistoryList.tsx#L24)
- **Activity reported** remains neutral. Applied/adopted events use success and
  recovery uses warning, all with text and icons. Local times use
  `YYYY/MM/DD HH:mm:ss` with the browser's numeric GMT offset and an exact UTC
  disclosure. Identifier
  buttons copy the full value. [EventDetails.tsx:16](../../packages/console/src/components/features/insights/EventDetails.tsx#L16),
  [timestamp:48](../../packages/console/src/components/features/insights/EventDetails.tsx#L48),
  [HashValueDisplay.tsx:28](../../packages/console/src/components/HashValueDisplay.tsx#L28)

## StyleSeed assessment

The review uses coherence (20), color (16), hierarchy (16), layout (12), states
(12), writing (12), and motion (12). The Console's 4px grid, Mira radius scale,
and semantic status colors take precedence over generic rubric defaults.

The source review and available 375px, 768px, and 1280px captures support the
deductions below. Browser measurements were made in the parent task; this review
independently inspected the saved captures. No unmeasured accessibility property
is converted into full marks, and no blanket 100-point score is issued.

| Component               | Source evidence and remaining check                                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| InsightsPageHeader      | No observed deduction: native links, current-page state, 44px mobile navigation, and one-row fit at 375px. [line 15](../../packages/console/src/components/features/insights/InsightsPageHeader.tsx#L15)                                                                                                                         |
| InsightsControls        | One named period group without a duplicate visible label. [line 20](../../packages/console/src/components/features/insights/InsightsControls.tsx#L20)                                                                                                                                                                            |
| InsightsOverview        | No observed deduction: one leading metric and two supporting values; opening UTC did not cause 375px page overflow. The replacement mobile capture also fits correctly. [line 130](../../packages/console/src/components/features/insights/InsightsOverview.tsx#L130)                                                            |
| ActivityChart           | No observed deduction: compact empty state/action, UTC interval, exact table, no animation, and a readable populated chart at 375px. [line 59](../../packages/console/src/components/features/insights/ActivityChart.tsx#L59)                                                                                                    |
| UpdateOutcomes          | Two-column metric hierarchy with numeric units; no repeated cell descriptions. [line 91](../../packages/console/src/components/features/insights/UpdateOutcomes.tsx#L91)                                                                                                                                                         |
| BundleSelector          | No observed deduction: 16px/44px search input, contained popup, and Clear restores options from an empty search. The empty-state capture shows the final short wording. [line 89](../../packages/console/src/components/features/insights/BundleSelector.tsx#L89)                                                                |
| BundleActivityChart     | No observed deduction: visible Applied / Recovered legend and UTC label; the populated mobile tooltip shows both named values. [UTC:111](../../packages/console/src/components/features/bundles/BundleActivityChart.tsx#L111), [legend:138](../../packages/console/src/components/features/bundles/BundleActivityChart.tsx#L138) |
| EventHistoryCard        | Coherence −3 resolved: first-page recovery stays 44px until lg. Width-based list/table, loading/error/empty, and Refresh remain. [line 227](../../packages/console/src/components/features/insights/EventHistoryCard.tsx#L227)                                                                                                   |
| EventHistoryList        | No observed deduction: text/icon statuses, 44px time/copy controls, readable metadata, and no horizontal scrolling at 375px/768px. [line 24](../../packages/console/src/components/features/insights/EventHistoryList.tsx#L24)                                                                                                   |
| EventDetails            | Shared status meanings, local time and exact UTC, full bundle copy. [line 48](../../packages/console/src/components/features/insights/EventDetails.tsx#L48)                                                                                                                                                                      |
| InstallationPageHeader  | Named Enter-submit lookup with 16px mobile input and 44px actions. [line 25](../../packages/console/src/components/features/insights/InstallationPageHeader.tsx#L25)                                                                                                                                                             |
| InstallationMatchesCard | No observed deduction: six matches collapse after selection, trigger focus returns, and desktop remains open. Empty/error handling has test coverage. [line 60](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L60)                                                                         |
| InstallationHistoryCard | Writing −2 resolved: unselected instruction appears once. Compact metadata and width-based history fit all three inspected widths. [line 80](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L80)                                                                                            |
| InsightsPagination      | Named region, explicit Previous/Next, disabled boundaries, 44px mobile controls. [line 23](../../packages/console/src/components/features/insights/InsightsPagination.tsx#L23)                                                                                                                                                   |
| InsightsErrorAlert      | Semantic alert and shared actionable error copy. [line 13](../../packages/console/src/components/features/insights/InsightsErrorAlert.tsx#L13)                                                                                                                                                                                   |

Both scored source findings are resolved: **+3 coherence** for the tablet
recovery target and **+2 writing** for removing the duplicate instruction. The
inspected design uses one icon family, semantic colors, a leading numeric
hierarchy, a shared inset grid, explicit data states, short action labels, and
reduced-motion handling. Formal contrast and assistive-technology coverage
remain separate limitations, not assumed passes.

## Verification and limitations

- Focused verification passed **6 files / 12 tests** for ActivityChart,
  InsightsOverview, UpdateOutcomes, InsightsControls, BundleSelector, and
  InstallationMatchesCard. The new chooser scenarios verify disclosure state,
  selection, focus return, and visible empty/error handling. Tests do not prove
  CSS visibility or viewport geometry. [chooser scenarios:27](../../packages/console/src/components/features/insights/InstallationMatchesCard.spec.tsx#L27)
- Parent browser QA measured page width equal to viewport width on Overview,
  Events, and installation history at 375px, 768px, and 1280px. Events had no
  visible table at 375px/768px; the 1280px table measured 974px and fit its card.
- At 375px, event/history primary links, buttons, and timestamp disclosures
  measured at least 44px tall. Search input text measured 16px and input height
  44px. The bundle popup occupied x=29px to x=346px (317px wide); clearing an
  unmatched search restored 26 options.
- Browser interaction verified six matching installations collapse after
  choosing one and focus returns to the disclosure. Returning from detail to
  Events preserved the source scroll position, **329px → 329px**. Expanding
  Overview UTC retained the 375px document width.
- The scale branch's complete integration verification passed **49 files** with
  **478 tests**; 7 files and 81 tests were intentionally skipped by their
  environment guards. Current unit, lint, type, and build results are recorded
  in [the scale review](./insights-scale-review.md).
- Loading and backend error coverage uses component/route tests rather than
  manufactured live failures. Formal contrast measurement, a screen-reader
  session, iOS-device testing, and independent 200% browser zoom are not yet
  established by this review.
- The checked-in seed contains July records, so recent-period Overview values
  are zero. For two supplementary populated-chart captures, only seed event
  timestamps were temporarily shifted by
  `Date.now() - Date.UTC(2026, 6, 18, 11)`. This produced 8 active installations
  and 3 reported bundles. The configuration is restored;
  `git diff` shows no change to `packages/console/hot-updater.config.ts`. These
  two images are explicitly fixture evidence, not production data.
- Event and installation views request one bounded cursor page at a time. The
  backend does not impose a 50,000-record total or retention ceiling.

## Screenshot evidence

The 375px Events capture was refreshed after the cursor cutover and inspected
again. It shows the final `Activity reported` label, semantic event colors,
`YYYY/MM/DD HH:mm:ss` browser-zone timestamps, and mobile cards without a
horizontal table. The other captures are retained from the preceding responsive
review; they support its layout findings but predate the final cursor and copy
changes and are not presented as fresh post-cutover browser evidence. Dimensions
are 375 × 844, 768 × 1024, and 1280 × 900.

| View                 | 375px phone                                                      | 768px tablet                                                      | 1280px desktop                                                      |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Overview             | [Phone](../public/docs/console/insights-overview-mobile.png)     | [Tablet](../public/docs/console/insights-overview-tablet.png)     | [Desktop](../public/docs/console/insights-events-entry.png)         |
| Events               | [Phone](../public/docs/console/insights-events-mobile.png)       | [Tablet](../public/docs/console/insights-events-tablet.png)       | [Desktop](../public/docs/console/insights-event-history.png)        |
| Installation history | [Phone](../public/docs/console/insights-installation-mobile.png) | [Tablet](../public/docs/console/insights-installation-tablet.png) | [Desktop](../public/docs/console/insights-installation-desktop.png) |

Supplementary 375px evidence:

- [Empty bundle picker](../public/docs/console/insights-bundle-picker-empty-mobile.png)
- [Populated Overview — temporary recent-date fixture](../public/docs/console/insights-overview-populated-mobile.png)
- [Populated bundle chart and tooltip — temporary recent-date fixture](../public/docs/console/insights-bundle-activity-populated-mobile.png)
- [Light Overview](../public/docs/console/insights-overview-light-mobile.png) and [light Events](../public/docs/console/insights-events-light-mobile.png)

The retained browser captures include development-tool launchers. No claim is
made that the retained captures replace a fresh assistive-technology, zoom, or
device session.
