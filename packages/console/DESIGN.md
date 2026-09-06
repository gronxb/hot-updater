# Hot Updater Console Design System

## 1. Product Character

The Console is a compact operational workspace, not a marketing dashboard.
It uses warm stone neutrals, restrained orange emphasis, quiet borders, and
dense but readable information layouts. Insights must feel native to the
existing bundle table and detail sheet rather than like a separate product.

The primary operator needs to answer three questions quickly: how many
installations reported in the selected period, what was reported for a selected
bundle, and where a specific installation currently points. Supporting context
stays subordinate to exact values and actions.

## 2. Foundations

### Color

- All product UI uses the semantic tokens in `src/styles.css`; component files
  do not introduce raw colors.
- `background`, `card`, `muted`, `border`, and their foreground counterparts
  create the warm-stone surface hierarchy in both themes.
- Orange `primary`/`accent` is the single emphasis color.
- `muted-foreground` is the neutral secondary treatment. Labels and values
  always communicate meaning without color.
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
- Insights uses one primary content column at 375 px, 768 px, and 1280 px.
  Scope controls precede reporting-installation and selected-bundle values.
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
  calculation details accessible without adding a visible paragraph to every
  section.

## 4. Capability and Data States

- Bundles and Insights navigation are always available. Installation history
  remains a drill-down route under the Insights Events view.
- Data surfaces define loading, empty, success, and genuine error states.
- Insights language is direct and evidentiary: use Reporting installations,
  Selected bundle installations, Applied reports, Recovered-from reports,
  Adopted reports, and Last known bundle. Reporting installations are unique
  install IDs whose latest report falls in the selected 24 hours, 7 days, or 30
  days. Outcome values count accepted reports. Never imply realtime state,
  complete fleet coverage, an exact share, success rate, or rollout completion.

## 5. Reusable Primitives

- **Route header:** `SidebarTrigger`, page title, and native view navigation;
  sticky with the existing border and translucent card treatment.
- **Operational card:** full shadcn `Card` composition with one clear title
  and no nested card grid. Add a description only when a label or direct
  action cannot convey necessary information.
- **Metric list:** semantic `dl` with exact tabular values and compact labels;
  separators may distinguish adjacent metrics.
- **History lookup:** shadcn `Field`, `InputGroup`, and `Button`, an explicit
  label, Enter submission, trimmed query, and visible focus. The lookup accepts
  either a user ID or install ID and opens the existing installation history
  drill-down. Matching installations form a collapsed selector below `lg`
  and remain alongside the history on wider screens.
- **Feedback:** shadcn `Skeleton` for loading and `Alert` for genuine errors;
  use a short state and direct action for empty lookup results, such as No
  matches / Edit search.

Primitive states are default, hover/focus for interactive controls, disabled
while submitting/loading when relevant, loading, empty, error, and success.

## 6. Insights-Specific Composition

- **Reporting installations:** the leading card shows the unique latest-state
  installation count for the selected platform, channel, and period, with its
  independent measurement time.
- **Selected bundle:** when a bundle is selected, show its latest-state
  installation count and independent Applied reports, Recovered-from reports,
  and Adopted reports counts. Each outcome links to event history using the
  same scope and receipt interval. Present the values independently without
  percentages.
- **All events:** shared Overview / Events navigation makes event history a
  primary Insights destination. Native links retain page-navigation semantics.
  The installation route without a search or selected installation shows every
  recorded event type, newest first, with no reporting-period or bundle filter.
  The title, refresh action, and compact installation lookup sit inside the list
  header. The lookup is not an event filter. Event history uses keyset pages and
  has no total-count claim. Each installation links to its history; returning
  restores the source event page and scroll position.
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
  labeled controls, table headers, and meaningful link names.
- A low-vision user at 200% zoom needs wrapping headers, visible primary
  actions, and no page-level horizontal overflow.
- A color-vision-deficient user must distinguish series and states by labels,
  values, tooltip text, and structure rather than hue alone.

### Accepted debt

- The current card primitive owns its existing single shadow and spacing
  defaults; G002 does not redesign shared shadcn primitives.
- Installation history remains on the existing route and is composed from
  focused search, matching-installation, and history primitives.
