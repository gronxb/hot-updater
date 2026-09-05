# Insights responsive review — 2026-09-05

The accepted storage contract's Console views were exercised in the local
fixture with a real browser at 1280 × 900 and 375 × 844. At both widths the
document matched the viewport, and the captured browser console had no errors.

For iOS / production / 7d and selected bundle
`01972020-1aa1-7445-8b8c-111111111111`, the fixture showed 8 reporting
installations, 3 naming the selected bundle, 7 applied reports, 2 recovered-from
reports, and 1 adopted report. The recovery drill-down contained two B → A
reports; adoption contained one B → B report. Switching to Android showed zero.
Exact `demo-alpha` lookup showed its current B state and one bundle movement.
The counters are independent measurements and are not presented as percentages.

| View                | Desktop                                                                 | Mobile                                                                |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Scoped overview     | [1280px](../public/docs/console/insights-contract-overview-desktop.png) | [375px](../public/docs/console/insights-contract-overview-mobile.png) |
| Recovery drill-down | [1280px](../public/docs/console/insights-contract-recovery-desktop.png) | [375px](../public/docs/console/insights-contract-recovery-mobile.png) |

The screenshots are native viewport captures, without review overlays. Component
and HTTP tests separately cover state transitions, counts, raw predicates,
Unicode identity, receipt boundaries, and cursor errors. This review concerns
the updated controls; the older review below records the earlier UI only.

## Historical review — 2026-09-04

Historical review of the earlier UI. The accepted 2026-09-05 contract adds
explicit platform/channel scope, selected-bundle counts, and outcome drill-down.
The measurements and screenshots below are evidence for the earlier commit;
they do not certify the updated controls.

This review covers the final Lean Insights scope: reporting-installation counts,
filter-free event history, exact user or installation lookup, and per-installation
bundle movement history. Removed bundle analytics, charts, report jobs, and the old
50,000-row application scan are intentionally outside the Console.

## Browser verification

The three retained workflows were exercised in a real browser at 375 × 844,
768 × 1024, and 1280 × 900. At every width, the document width matched the
viewport width. Mobile and tablet render event cards; desktop renders the denser
event table. The browser run also verified:

- Insights opens a single reporting-installations metric with 24h, 7d, and 30d
  controls. The count is live and the footer says **Measured at**.
- Events opens the unfiltered history immediately. No search is required.
- Exact `demo-alpha` lookup selects its installation, collapses the result chooser
  on smaller screens, and shows only bundle movement history.
- Primary mobile controls and pagination targets are 44px tall. Result selection
  returns focus to the collapsed chooser.
- Only the current cursor is serialized in the URL. Previous-page cursors stay in
  route memory, keeping deep event navigation independent of browser URL limits.
- Times use `YYYY/MM/DD HH:mm:ss GMT±N` in the browser's resolved time zone. Each
  timestamp expands to an exact UTC value.
- `Activity reported` is neutral, `Bundle applied` uses success styling, and
  `Recovered` uses warning styling. Each state includes text and an icon.
- Loading, empty lookup, empty history, error, disabled pagination, and refresh
  states are represented in the component or route behavior.

Implementation evidence: responsive event switching and data states are in
[EventHistoryCard.tsx:111](../../packages/console/src/components/features/insights/EventHistoryCard.tsx#L111),
timestamp and event semantics are in
[EventDetails.tsx:10](../../packages/console/src/components/features/insights/EventDetails.tsx#L10),
the responsive installation history is in
[InstallationHistoryCard.tsx:73](../../packages/console/src/components/features/insights/InstallationHistoryCard.tsx#L73),
the collapsible result chooser is in
[InstallationMatchesCard.tsx:39](../../packages/console/src/components/features/insights/InstallationMatchesCard.tsx#L39),
and bounded page controls are in
[InsightsPagination.tsx:20](../../packages/console/src/components/features/insights/InsightsPagination.tsx#L20).

## StyleSeed score

The final source and rendered states score **94/100**, above the 80-point shipping
gate.

| Category   | Score | Evidence                                                                                                                                     |
| ---------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Coherence  | 18/20 | Shared card, button, badge, icon, spacing, and radius primitives; 44px mobile controls.                                                      |
| Color      | 14/16 | Color is reserved for selected navigation and semantic event states; formal contrast instrumentation was not run.                            |
| Hierarchy  | 15/16 | One leading metric, clear page titles, quiet metadata, and compact secondary actions.                                                        |
| Layout     | 12/12 | Card and table modes follow container width, identifiers wrap or truncate intentionally, and no page-level horizontal overflow was observed. |
| States     | 11/12 | Loading, error, empty, selected, disabled, and refresh states are explicit; a screen-reader session was not run.                             |
| UX writing | 12/12 | Labels describe user intent: **Reporting installations**, **All events**, **Activity reported**, and **User ID or installation ID**.         |
| Motion     | 12/12 | Motion is limited to short state transitions and respects reduced motion.                                                                    |

The Overview hierarchy is visible in
[InsightsOverview.tsx:63](../../packages/console/src/components/features/insights/InsightsOverview.tsx#L63).
Semantic badge labels and colors are defined together in
[EventDetails.tsx:10](../../packages/console/src/components/features/insights/EventDetails.tsx#L10).

## Screenshot evidence

All screenshots use the checked-in local fixture and were captured without review
or development overlays.

| View                 | 375px phone                                                      | 768px tablet                                                      | 1280px desktop                                                      |
| -------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| Overview             | [Phone](../public/docs/console/insights-overview-mobile.png)     | [Tablet](../public/docs/console/insights-overview-tablet.png)     | [Desktop](../public/docs/console/insights-events-entry.png)         |
| All events           | [Phone](../public/docs/console/insights-events-mobile.png)       | [Tablet](../public/docs/console/insights-events-tablet.png)       | [Desktop](../public/docs/console/insights-event-history.png)        |
| Installation history | [Phone](../public/docs/console/insights-installation-mobile.png) | [Tablet](../public/docs/console/insights-installation-tablet.png) | [Desktop](../public/docs/console/insights-installation-desktop.png) |

## Verification boundary

Browser QA establishes responsive layout, visible interaction states, and the
exact lookup flow. Component and route tests cover deterministic loading, error,
empty, cursor, and navigation behavior. A formal contrast audit, screen-reader
session, physical-device run, and 200% zoom audit remain separate checks.
