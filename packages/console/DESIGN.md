# Hot Updater Console Design System

## 1. Product Character

The Console is a compact operational workspace, not a marketing dashboard.
It uses warm stone neutrals, restrained orange emphasis, quiet borders, and
dense but readable information layouts. Analytics must feel native to the
existing bundle table and detail sheet rather than like a separate product.

The primary operator needs to answer three questions quickly: what is tracked,
which bundle is most active, and where a reported installation currently
points. Supporting context stays subordinate to exact values and actions.

## 2. Foundations

### Color

- All product UI uses the semantic tokens in `src/styles.css`; component files
  do not introduce raw colors.
- `background`, `card`, `muted`, `border`, and their foreground counterparts
  create the warm-stone surface hierarchy in both themes.
- Orange `primary`/`accent` is the single emphasis color. In charts,
  `chart-2` represents the primary Installed or observed-adoption series.
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
- Analytics uses one primary content column at 375 px, a balanced intermediate
  layout at 768 px, and an asymmetric two-column grid at 1280 px. Adoption has
  primary visual weight; summaries and rollout configuration are subordinate.
- Group with alignment, separators, and whitespace before adding containers.
  Do not nest generic KPI cards inside a larger card or repeat equal KPI tiles.
- Tables may scroll horizontally inside their own container. The page itself
  must not overflow at 375 px or 200% zoom.
- Route headers remain compact, sticky, and aligned with the existing sidebar
  trigger. Context copy wraps instead of forcing a wider header.

## 4. Capability and Data States

- Bundles is always available.
- Analytics navigation, Installations navigation, protected route content,
  protected queries, and per-bundle activity are absent until
  `supportsAnalytics` is confirmed true.
- An unresolved protected route shows only a neutral, layout-stable shell
  loading state. Unsupported routes redirect to Bundles without mounting or
  flashing protected content. Capability discovery errors show a compact
  diagnostic state and a Bundles escape path, with no protected query.
- Data surfaces define loading, empty, success, and genuine error states.
  Unsupported capability is absence, not an error or empty-state card.
- Analytics language is evidentiary: use tracked, observed, latest reported,
  configured rollout, and Last known bundle. Never imply realtime state,
  complete fleet coverage, or rollout completion.

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
- **Rollout row:** bundle identity, observed count, exact configured
  percentage, and shadcn `Progress`; orange is reserved for the progress
  indicator.
- **Search form:** shadcn `InputGroup` and `Button`, an explicit label,
  Enter submission, trimmed query, and visible focus. Results use shadcn
  `Table` and link to the existing installation detail route.
- **Feedback:** shadcn `Skeleton` for loading and `Alert` for genuine errors;
  compact explanatory copy for empty states.

Primitive states are default, hover/focus for interactive controls, disabled
while submitting/loading when relevant, loading, empty, error, and supported
success. Capability-unavailable primitives do not render.

## 6. Analytics-Specific Composition

- **Update activity:** one compact card with Installed and Recovered lifetime
  values followed directly by a short 30-day cumulative chart. Do not repeat
  Lifetime, UTC, or 30-day labels, and do not add explanatory framing already
  carried by the title and accessible chart name.
- **Adoption:** one dominant observed-adoption chart plus exact bundle count
  and share rows. Unknown/deleted bundles keep their identifier and a clear
  unavailable-metadata label.
- **Overview summary:** tracked installation total and most active observed
  bundle share one compact block rather than separate KPI tiles.
- **Configured rollout:** ranked compact rows with progress and exact
  percentage. Configuration is not presented as observed completion.
- **Installation search:** accepted identity fields are explained before
  submission. Results show identity fallback, install id, Last known bundle,
  platform, channel, and app version.

## 7. Motion and Interaction

- No decorative motion or automatic chart animation is introduced.
- Existing focus, hover, sidebar, and sheet behavior remains authoritative.
- Controls use existing transition utilities only for meaningful state
  feedback. Reduced-motion behavior from the shared stack is preserved.
- Search is keyboard-operable in source order: input, Search button, then
  result links.

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

- Final screenshot-based reference-fidelity and multi-viewport visual QA are
  intentionally deferred for G002 implementation handoff because the task
  explicitly forbids final screenshot capture in this phase.
- The current card primitive owns its existing single shadow and spacing
  defaults; G002 does not redesign shared shadcn primitives.
- Installation history remains on the existing route and receives terminology
  alignment only; broader route decomposition is outside this focused change.
