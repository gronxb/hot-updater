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
- Every release and artifact ID the Console shows is its tail: the whole
  UUIDv7 in the text, so screen readers read all of it, clipped from the
  left to its last 12 characters (`ID_TAIL`, a UUID's last group; the head
  is a timestamp neighbouring IDs share). Nothing shows one in full, as a
  shorter slice, or as a head…tail pill; `IdTails.spec.tsx` fails on any
  other clip width, on an ID printed as bare text, and on a release or
  artifact ID passed to `HashValueDisplay`, whose pill is for install IDs
  and content hashes.
- A labeled release reads `v12 <ID tail>` (`ReleaseIdDisplay`): the label
  in medium `text-sm`, then its ID tail in muted monospace `text-sm` on the
  same baseline, with a plain gap and no dot between them. A release without
  a label shows its tail alone, after a muted dash where the label would
  open it (`labelAs`), and the dash reads as its whole ID unless the control
  names itself. The label and tail don't shrink, so a badge beside them
  (Promoted, Unreachable, Disabled) shares a `flex-wrap` row with them and
  moves under them on a narrow screen rather than over the tail.
- Where a surface heads a release's values, the label and the ID split so
  `v12` never sits under "ID": the Bundles table has a Label column then an
  ID column, and the release sheet a Label row then an ID row
  (`ReleaseIdDisplay` with `part="label"` and `part="id"`). The expand
  chevron has a narrow first column of its own, headed only for screen
  readers ("Expand"), with an empty cell for a built-in bundle, so "Label"
  sits over `v12` and "ID" over the tail. An unreachable fold's chevron sits
  in a box as wide as the rows' chevron button (`DataTableFold`'s
  `leadColumn`), so the two chevrons share a center and the fold's text
  starts under "Label". The Label column holds only the label, and the
  row's badges follow the ID tail in the ID column, so the column stays as
  narrow as the label and the tail sits right after it, read in the card's
  order. The ID there is the same 12-character tail as the copy button,
  labeled or not. A release without a label
  shows a muted dash in the Label column, which still opens it, and no Label
  row in the sheet. Split, both take `text-xs` and the ID takes
  `text-foreground`, the size and color of the values beside them (Target,
  Platform, Channel), and the copy button's phone touch area grows to stay
  44 px tall. The label stays plain medium text, never a chip, since chips
  in that table mean channel, patch count, and operation.
  Everywhere without a header for each value (phone Bundles cards,
  Insights, Served now, pickers, chart tooltips, diagnostics), the label and
  tail stay together as `v12 <ID tail>`.
- A label is unique only within a channel and platform: production iOS v14,
  production Android v14, and beta iOS v14 are three releases. Where one
  surface lists both platforms' releases, such as Insights with All
  platforms, `ReleaseIdDisplay` gets `platform` and shows its muted icon
  before the label, read as the platform's name. Where the screen fixes the
  platform, or the row already shows it (a Bundles row's platform and channel
  badge, the release sheet, a native build's served releases), nothing more
  shows. No labeled surface mixes channels without a channel badge in the
  row, so labels carry no channel prefix.
- A label's tail is its release ID (what the app's `getBundleId()`
  returns): its tooltip shows and its copy copies that ID, never an
  artifact's, so `vN` reads the same on every screen.
- "Bundle ID" in Console copy means the release ID. An artifact's ID shows
  through `ArtifactIdDisplay`, which takes no label, and its copy says
  "artifact". `ReleaseIdDisplay` is the only display that takes a label.
- An artifact's ID is the same tail and copy button as a release's
  (`ArtifactIdDisplay`), and its popover says "Artifact ID" and its button
  "Copy artifact ID". Inside a link it is text with the full ID in `title`
  (`copyable={false}`). Where an installation reported a bundle with no
  release, such as the built-in bundle, Insights shows that artifact ID
  (`ReportedBundleId`); otherwise the release ID.
- Where an artifact shows (advanced artifact diagnostics' base and target),
  its ID tail shows first, then "Release" and the label of the release serving it
  in the expanded Bundle's channel and platform. Without one on the page,
  the artifact ID shows alone, never another channel's label. A native
  build's patches name each target by the release serving it in the build's
  scope now, and date it by that release, as Served now does; an older
  target shows as "Artifact" and its ID, dated by the artifact, linking to
  the Bundles list filtered to that artifact (`?artifactId=`).
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

- Navigation shows only installed features: Bundles always, Insights when the
  server runs `insights()`, and API keys when it runs `apiKeys()`. A
  self-hosted server's admin API serves events but no overview, so there
  Insights opens on All events and hides Overview. Installation history
  remains a drill-down route under the Insights Events view.
- A feature route opened without its plugin shows a not-installed state that
  names the plugin to add and links to the console deployment guide. Inline
  Insights, the bundle list column and the bundle detail card, is absent
  where the console does not read release activity; it never stands in with
  a placeholder or a banner.
- Data surfaces define loading, empty, success, and genuine error states.
- Insights language is direct and evidentiary: use Reporting installations,
  Selected bundle installations, Applied reports, Recovered-from reports,
  Adopted reports, and Last known bundle. Reporting installations are unique
  install IDs whose latest report falls in the selected 24 hours, 7 days, or 30
  days. Outcome values count accepted reports. Never imply realtime state,
  complete fleet coverage, an exact share, success rate, or rollout completion.
- Unique counts read from sketches (DAU, WAU, MAU, active users per interval,
  and Release health's active installations) are estimates, typically within
  about 3%. Show them with ≈ and an Estimated label for hover and screen
  readers; zero stays exact. Report, active-day, failed-launch, and
  latest-state counts are exact.

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

- **ID copy:** a release's or an artifact's ID tail is a button of its own.
  Hover or keyboard focus opens a tooltip with the full ID and Click to copy;
  a click, Enter, or a tap copies the full ID and the same tooltip says
  Copied (Couldn't copy on failure), with a polite status for screen readers.
  It never sits inside another control: where the label opens something (the
  Bundles row's button, Served now's link), that control wraps only `vN`
  through `labelAs`, and the tail stays beside it, keeping its click from the
  row. Inside a control that can't hold a button (a combobox option, a chart
  tooltip), pass `copyable={false}`: the tail is text, and the full ID shows
  on hover from `title`.
  The tail clips inside the button, so its phone touch area stays 44 px
  tall. A dialog that names a release with it, such as Roll back, gives
  first focus to Cancel, so no tooltip opens over it. Being a button, the
  tail doesn't take a text selection; the click copies.

Primitive states are default, hover/focus for interactive controls, disabled
while submitting/loading when relevant, loading, empty, error, and success.

## 6. Insights-Specific Composition

- **Reporting installations:** the leading card shows the unique latest-state
  installation count for the selected platform, channel, and period, with its
  independent measurement time.
- **Compared bundles:** Release health compares its bundles in a table from
  32 rem of card width. A narrower card lists them instead, one bundle per
  item: its line color, label and ID tail with their badges, and deployment on
  top, with the Remove button beside them at 44 px; then each count under the
  name its table column has, in a `dl`. Both copies render the same name and
  counts, so they can't drift, and only the card width picks one. Nothing in
  either copy spills its cell or breaks mid-word, from 360 px up.
- **Selected bundle:** when a bundle is selected, show its latest-state
  installation count and independent Applied reports, Recovered-from reports,
  and Adopted reports counts. Each outcome links to event history using the
  same scope and receipt interval. Present the values independently without
  percentages.
- **All events:** shared Overview / Events navigation makes event history a
  primary Insights destination. Native links retain page-navigation semantics.
  The installation route without a search or selected installation lists
  downloads, applies, and recoveries in one time range, newest first, with no
  bundle filter: the last 24 hours, 7 days (default), 30 days, or 90 days,
  ending when the list loads or the range changes. Launches without an update
  are not listed; they appear in App usage and in an installation's latest
  report, and a one-line description under the title says so. The title, time
  range, refresh action, and compact installation lookup sit inside the list
  header. The lookup is not an event filter. Event history uses keyset pages
  that stop at the range start and has no total-count claim. An empty range
  and the range start say so and offer the next longer range. Each
  installation links to its history; returning restores the source event
  page, range, and scroll position.
  Wide table columns follow time, event, user ID / install ID, app, and bundle.
  Narrow event rows lead with status and time, then identity, app, and bundle;
  this preserves each event's context without hiding columns offscreen. Times
  use YYYY/MM/DD HH:mm:ss in the browser's named time zone, with expandable
  exact UTC values. User IDs lead; shortened install and bundle IDs reveal and
  copy their full values. UNCHANGED, an installation's latest report or an
  older stored row, is presented as No change, a neutral observation on the
  current bundle. Applied/adopted events use the semantic success color;
  recovery uses warning. Text and icons remain present so color is never the
  only distinction.
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
