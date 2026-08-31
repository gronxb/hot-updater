# Hot Updater Console Design System

## 1. Product Character

The Console is a compact operational workspace, not a marketing dashboard.
It uses warm stone neutrals, restrained orange emphasis, quiet borders, and
dense but readable information layouts. Insights must feel native to the
existing bundle table and detail sheet rather than like a separate product.

The primary operator needs to answer three questions quickly: how many
installations are active in the selected period, how those installations are
distributed by bundle, and where a specific installation currently points.
Supporting context stays subordinate to exact values and actions.

### Insights dashboard reference

The Insights composition takes its information hierarchy from Expo's public
EAS Observe > EAS Update dashboard without copying Expo branding or metrics:

- a compact period control precedes the report;
- one full-width activity card is the primary analytical surface, with a
  period-aware active-installation value above the chart and supporting values
  aligned below it;
- the overview chart shows one aggregate installation-activity series so the
  selected-bundle inspector remains the place for bundle-specific analysis;
- the selected-bundle inspector follows the installation activity card rather
  than competing with the primary chart.

Hot Updater keeps its warm-stone surfaces, orange semantic accent, existing
type scale, and 4 px spacing grid. The reference contributes dashboard
structure only.

## 2. Foundations

### Color

- All product UI uses the semantic tokens in `src/styles.css`; component files
  do not introduce raw colors.
- `background`, `card`, `muted`, `border`, and their foreground counterparts
  create the warm-stone surface hierarchy in both themes.
- Orange `primary`/`accent` is the single emphasis color. In charts,
  `chart-2` represents the primary Newly applied, reporting-installation, or
  bundle-distribution series.
- `muted-foreground` or `chart-1` is the neutral secondary-series treatment.
  Labels, values, and tooltips always communicate meaning without color.
- Destructive color is reserved for genuine errors and destructive actions,
  never normal insights status.

### Typography

- Inter Variable is the UI typeface, with the platform stack as the initial
  fallback and the existing monospace stack for identifiers.
- Page headings use `text-base` or `text-lg` with semibold weight. Operational
  card titles use `text-sm` with medium or semibold weight.
- Body and control text use `text-sm`; dense metadata and table content use
  `text-xs`. Exact metrics use `text-2xl` or `text-3xl`, semibold,
  `tracking-tight`, and `tabular-nums`.
- Search inputs use at least 16 px text below `lg` to avoid automatic zoom on
  iOS. Keep input and adjacent actions at least 44 px tall in that range;
  desktop controls retain the Console's compact density.
- Sentence case is mandatory. Uppercase is limited to short metadata labels
  already established by the Console.

### Spacing and shape

- The base unit is 4 px. Standard gaps are 8, 12, 16, and 24 px.
- Route padding is 12 px on narrow screens and 24 px from `sm` upward.
- Card headers and contents share a 16 px inset on narrow screens and 24 px
  from `sm`; do not mix insets within one surface.
- The shadcn Mira small-radius scale is authoritative. Cards use the existing
  `rounded-xl`; controls use `rounded-md`.
- Borders and subtle tonal shifts provide depth. Existing card shadow is the
  maximum elevation; insights adds no glow, glass, or decorative shadow.

## 3. Layout Grammar

- The fixed sidebar and route-owned scrolling shell remain unchanged.
- Insights uses one primary content column at 375 px and 768 px. At 1280 px,
  the installation activity chart remains full width and carries the leading
  value. Reported bundles and the timestamp form one compact footer. A
  searchable bundle selector then introduces the selected-bundle detail.
  Installation search remains full width.
- Group with alignment, separators, and whitespace before adding containers.
  Do not nest generic KPI cards inside a larger card or repeat equal KPI tiles.
- Insights event history responds to the available card width, not only the
  viewport. All Events uses a table from 58 rem; installation history uses a
  table from 48 rem. Narrower cards show a vertical event list with the same
  time, status, identity, app, and bundle information. Reading an event must
  not require horizontal scrolling. The page itself must not overflow at
  375 px or 200% zoom.
- Route headers remain compact, sticky, and aligned with the existing sidebar
  trigger. Insights title and Overview / Events navigation share one row when
  space allows. Navigation and primary mobile actions have 44 px touch targets.
- Use labels, exact values, and controls to explain the interface. Avoid a
  title followed by a sentence that repeats it. Keep metric definitions and
  chart calculation details accessible without adding a visible paragraph to
  every section.

## 4. Capability and Data States

- Bundles is always available.
- Insights navigation, protected route content, protected queries, and
  per-bundle activity are absent until `supportsInsights` is confirmed true.
  Installation history remains a drill-down route under the single Insights
  navigation state.
- An unresolved protected route shows only a neutral, layout-stable shell
  loading state. Unsupported routes redirect to Bundles without mounting or
  flashing protected content. Capability discovery errors show a compact
  diagnostic state and a Bundles escape path, with no protected query.
- Data surfaces define loading, empty, success, and genuine error states.
  Unsupported capability is absence, not an error or empty-state card.
- Insights language is direct and evidentiary: use Active installations,
  Latest bundle share, Newly applied, Recovered away, Configured rollout, and
  Last known bundle. Daily, Weekly, and Monthly active installations mean
  unique install IDs that sent at least one update status in the selected 24
  hours, 7 days, or 30 days. This is installation activity, not unique user
  accounts. Never imply realtime state, complete fleet coverage, or rollout
  completion.

## 5. Reusable Primitives

- **Route header:** `SidebarTrigger`, page title, and native view navigation;
  sticky with the existing border and translucent card treatment.
- **Operational card:** full shadcn `Card` composition with one clear title
  and no nested card grid. Add a description only when a label or direct
  action cannot convey necessary information.
- **Metric list:** semantic `dl` with exact tabular values and compact labels;
  separators may distinguish adjacent metrics.
- **Chart:** shadcn `ChartContainer` wrapping Recharts, with
  `accessibilityLayer`, an accessible name, semantic token colors, tooltip, and
  exact text/table equivalent in the DOM.
- **Rollout row:** bundle identity, reported-in-range count, exact configured
  percentage, and shadcn `Progress`; orange is reserved for the progress
  indicator.
- **History lookup:** shadcn `Field`, `InputGroup`, and `Button`, an explicit
  label, Enter submission, trimmed query, and visible focus. The lookup accepts
  either a user ID or install ID and opens the existing installation history
  drill-down. Matching installations form a collapsed selector below `lg`
  and remain alongside the history on wider screens.
- **Feedback:** shadcn `Skeleton` for loading and `Alert` for genuine errors;
  a short state and direct action for empty results, such as No activity /
  View events or No matches / Edit search. Do not reserve a large empty plot
  for zero activity.

Primitive states are default, hover/focus for interactive controls, disabled
while submitting/loading when relevant, loading, empty, error, and supported
success. Capability-unavailable primitives do not render.

## 6. Insights-Specific Composition

- **Selected bundle activity:** one full-width operational card below the
  installation activity card. Its header contains the searchable selector so
  the title, control, and card content share one inset and information
  hierarchy instead of forming a detached toolbar. On wide screens the title
  group and selector align to the same top edge; on narrow screens they stack
  in source order. The selected bundle ID appears only in the selector instead
  of being repeated above the metrics. Its metric rail shows Latest bundle
  share (installs whose latest report ends on the selected bundle, divided by
  all reporting installs in the selected period), Newly applied, Recovered
  away, and Configured rollout. The movement summary and chart use the same
  selected period. The chart shows per-bucket distinct movement rather than
  a cumulative total, with a visible series legend and UTC label.
  Metrics use two columns on narrow screens and four on wide screens, with
  compact units rather than a repeated explanatory line under every value.
- **Installation activity:** Daily, Weekly, or Monthly active installations is
  the leading metric above one full-width aggregate chart. The leading value
  deduplicates install IDs across the whole selected period. Each UTC chart
  bucket separately deduplicates install IDs within that hour or day, so an
  installation may appear in more than one point and the points must not be
  summed to reproduce the period total. Exact values remain available in the
  tooltip and screen-reader table. The title names the selected period; do not
  repeat Active installations, the period, and Activity over time around the
  same number. A populated chart needs only Per hour / Per day and UTC.
  Reported bundles and As of form one compact footer rather than separate
  KPI cards. Bundle IDs do not compete in the overview; the searchable bundle
  detail below provides a human-readable platform, channel, and target-version
  identity.
- **Configured rollout:** configuration is presented beside the selected
  bundle's latest bundle share, never as reported completion.
- **All events:** shared Overview / Events navigation makes event history a
  primary Insights destination. Native links retain page-navigation semantics.
  The installation route without a search or selected installation shows every
  recorded event type, newest first, with no reporting-period or bundle filter.
  The title, total count, refresh action, and compact installation lookup sit
  inside the list header. The lookup is not an event filter. Pagination respects
  the existing Insights scan limit. Queries fail above the limit; this is not a
  storage limit, and installation lookup does not bypass it. Show this
  constraint when it causes a query error, not as a permanent banner. Each
  installation links to its history; returning restores the source event page
  and scroll position.
  Wide table columns follow time, event, user ID / install ID, app, and bundle.
  Narrow event rows lead with status and time, then identity, app, and bundle;
  this preserves each event's context without hiding columns offscreen. Times
  use YYYY/MM/DD HH:mm:ss in the browser's named time zone, with expandable
  exact UTC values. User IDs lead; shortened install and bundle IDs reveal and
  copy their full values. UNCHANGED is presented as Activity reported, a neutral activity
  observation on the current bundle. Applied/adopted events use the semantic
  success color; recovery uses warning. Text and icons remain present so color
  is never the only distinction.
- **Installation history:** the Events lookup accepts a user ID or install
  ID and routes to the installation history drill-down. A user ID may match
  multiple installations; below `lg`, a labeled count and disclosure keep
  those matches collapsed until needed, then collapse again after selection.
  Errors and empty results remain visible. At `lg` and above the matches are
  always visible alongside the history. An install ID identifies one history.
  Every history event shows the app version reported with that event beside
  its bundle transition.

## 7. Motion and Interaction

- No decorative motion or automatic chart animation is introduced.
- Existing focus, hover, sidebar, and sheet behavior remains authoritative.
- Controls use existing transition utilities only for meaningful state
  feedback. Reduced-motion behavior from the shared stack is preserved.
- History lookup is keyboard-operable in source order: input, Find installation,
  then the matching-installation disclosure and history controls on the
  drill-down. Selecting a match returns focus to the disclosure before hiding
  the list. Mobile timestamp disclosure, identifier copy, period, search,
  refresh, and pagination actions have targets of at least 44 px.

## 8. Accessibility, Personas, and Accepted Debt

### Personas and constraints

- A release operator scanning under time pressure needs exact values, compact
  hierarchy, and stable placement.
- A keyboard or screen-reader user needs semantic headings, `dl` metrics,
  labeled controls, table headers, meaningful link names, and text equivalents
  for every chart.
- A low-vision user at 200% zoom needs wrapping headers, visible primary
  actions, and no page-level horizontal overflow.
- A color-vision-deficient user must distinguish series and states by labels,
  values, tooltip text, and structure rather than hue alone.

### Accepted debt

- The current card primitive owns its existing single shadow and spacing
  defaults; G002 does not redesign shared shadcn primitives.
- Installation history remains on the existing route and is composed from
  focused search, matching-installation, and history primitives.
