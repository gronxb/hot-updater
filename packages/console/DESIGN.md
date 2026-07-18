# Hot Updater Console Design System

## 1. Product Character

The Console is a compact operational workspace, not a marketing dashboard.
It uses warm stone neutrals, restrained orange emphasis, quiet borders, and
dense but readable information layouts. Analytics must feel native to the
existing bundle table and detail sheet rather than like a separate product.

The primary operator needs to answer three questions quickly: how many
installations are active in the selected period, how those installations are
distributed by bundle, and where a specific installation currently points.
Supporting context stays subordinate to exact values and actions.

### Analytics dashboard reference

The Analytics composition takes its information hierarchy from Expo's public
EAS Observe > EAS Update dashboard without copying Expo branding or metrics:

- a compact status-and-filter toolbar precedes the report;
- one full-width trend card is the primary analytical surface, with the leading
  value above the chart and supporting values aligned below it;
- per-update comparison rows become per-bundle rows with a relative activity
  bar, exact Active count, and share;
- secondary operational panels follow the bundle comparison rather than
  competing with the primary chart.

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
  `chart-2` represents the primary Newly applied, observed-installation, or
  bundle-distribution series.
- `muted-foreground` or `chart-1` is the neutral secondary-series treatment.
  Labels, values, and tooltips always communicate meaning without color.
- Destructive color is reserved for genuine errors and destructive actions,
  never normal analytics status.

### Typography

- Inter Variable is the UI typeface, with the platform stack as the initial
  fallback and the existing monospace stack for identifiers.
- Page headings use `text-base` or `text-lg` with semibold weight. Operational
  card titles use `text-sm` with medium or semibold weight.
- Body and control text use `text-sm`; dense metadata and table content use
  `text-xs`. Exact metrics use `text-2xl` or `text-3xl`, semibold,
  `tracking-tight`, and `tabular-nums`.
- Sentence case is mandatory. Uppercase is limited to short metadata labels
  already established by the Console.

### Spacing and shape

- The base unit is 4 px. Standard gaps are 8, 12, 16, and 24 px.
- Route padding is 12 px on narrow screens and 24 px from `sm` upward.
- The shadcn Mira small-radius scale is authoritative. Cards use the existing
  `rounded-xl`; controls use `rounded-md`.
- Borders and subtle tonal shifts provide depth. Existing card shadow is the
  maximum elevation; analytics adds no glow, glass, or decorative shadow.

## 3. Layout Grammar

- The fixed sidebar and route-owned scrolling shell remain unchanged.
- Analytics uses one primary content column at 375 px and 768 px. At 1280 px,
  the activity trend remains full width and carries the leading value. Its
  supporting values form one bordered footer rail. Bundle activity follows as
  a full-width comparison table; only the secondary outcome and rollout panels
  share a row. Installation search remains full width.
- Group with alignment, separators, and whitespace before adding containers.
  Do not nest generic KPI cards inside a larger card or repeat equal KPI tiles.
- Tables may scroll horizontally inside their own container. The page itself
  must not overflow at 375 px or 200% zoom.
- Route headers remain compact, sticky, and aligned with the existing sidebar
  trigger. Context copy wraps instead of forcing a wider header.

## 4. Capability and Data States

- Bundles is always available.
- Analytics navigation, protected route content, protected queries, and
  per-bundle activity are absent until `supportsAnalytics` is confirmed true.
  Installation history remains a drill-down route under the single Analytics
  navigation state.
- An unresolved protected route shows only a neutral, layout-stable shell
  loading state. Unsupported routes redirect to Bundles without mounting or
  flashing protected content. Capability discovery errors show a compact
  diagnostic state and a Bundles escape path, with no protected query.
- Data surfaces define loading, empty, success, and genuine error states.
  Unsupported capability is absence, not an error or empty-state card.
- Analytics language is direct and evidentiary: use Observed installations,
  Observed by bundle, Observed adoption, Newly applied, Recovered away,
  Configured rollout, and Last known bundle. Avoid the ambiguous standalone
  terms Active and Installed, as well as transport or lifecycle implementation
  terms in visible copy. Never imply realtime state, complete fleet coverage,
  or rollout completion.

## 5. Reusable Primitives

- **Route header:** `SidebarTrigger`, page title, and one concise context line;
  sticky with the existing border and translucent card treatment.
- **Operational card:** full shadcn `Card` composition with one clear title,
  optional concise description, and no nested card grid.
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
  drill-down, where matching installations use the shadcn `Table`.
- **Feedback:** shadcn `Skeleton` for loading and `Alert` for genuine errors;
  compact explanatory copy for empty states.

Primitive states are default, hover/focus for interactive controls, disabled
while submitting/loading when relevant, loading, empty, error, and supported
success. Capability-unavailable primitives do not render.

## 6. Analytics-Specific Composition

- **Selected bundle adoption:** one full-width operational card for the bundle
  selected in the toolbar. Its metric rail shows Observed adoption (bundle
  installations divided by all installations observed in the selected
  period), Newly applied, Recovered away, and Configured rollout. The movement
  summary and chart use the same selected period. The chart shows per-bucket
  distinct movement rather than a cumulative total.
- **Observed by bundle:** one dominant comparison table with a relative horizontal
  activity bar, exact observed count, and share in every row, matching the
  comparison grammar of the EAS reference. Unknown/deleted bundles keep their
  identifier and a clear unavailable-metadata label. Each installation is
  counted once under its latest bundle in the selected period.
- **Activity overview:** Observed installations is the leading metric above the
  full-width trend chart. Bundles, Top observed bundle, and As of form one
  compact footer rail rather than separate KPI cards.
- **Configured rollout:** configuration is presented beside the selected
  bundle's observed adoption, never as observed completion.
- **Installation history:** the analytics toolbar accepts a user ID or install
  ID and routes to the installation history drill-down. A user ID may match
  multiple installations; the drill-down keeps those matches visible while an
  install ID identifies one history.

## 7. Motion and Interaction

- No decorative motion or automatic chart animation is introduced.
- Existing focus, hover, sidebar, and sheet behavior remains authoritative.
- Controls use existing transition utilities only for meaningful state
  feedback. Reduced-motion behavior from the shared stack is preserved.
- History lookup is keyboard-operable in source order: input, Search button,
  then the matching installations and history controls on the drill-down.

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
