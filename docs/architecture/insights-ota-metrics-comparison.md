# OTA metrics: EAS Update and CodePush

Reviewed on 2026-09-15; decisions updated on 2026-09-20. This comparison
separates documented product semantics from implementation evidence. Expo does
not document its internal Insights database layout. The Microsoft implementation
below is the published standalone CodePush server; it does not establish every
detail of the former hosted App Center service.

## Product semantics

| Question                                        | EAS Update Insights                                                              | CodePush install metrics                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| What is adoption?                               | Distinct users who ran an update within the selected window                      | Active installations still attributed to a release after reported transitions                    |
| Does moving from B to C remove adoption from B? | A user remains in B's unique-user count if their B activity is inside the window | B's Active decreases and C's Active increases                                                    |
| What accumulates?                               | Launch and failed-launch metrics, alongside a separate unique-user metric        | Successful installations, download reports, and rollback reports                                 |
| How is time used?                               | Explicit time windows and daily activity series                                  | The published install-metrics API reads accumulated counters without a date filter               |
| What is Pending?                                | Not a field in the reviewed update-insights response                             | The CLI derives it as downloaded minus installed minus failed; it only displays positive results |

EAS exposes unique users separately from launches and failed launches. Its CLI
labels the fields named `installs` and `failedInstalls` as launches and failed
launches. These names are not evidence of lifetime unique download counts.
See the [official response definitions](https://github.com/expo/skills/blob/main/plugins/expo/skills/eas-update-insights/references/update-insights-schema.md),
[CLI formatter](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/update/insights/formatInsights.ts),
and [adoption documentation](https://docs.expo.dev/eas-update/download-updates/#monitoring-adoption-of-updates).

CodePush defines Active as the version an installation would run when opened,
and Total as accumulated successful installations. Active is not a count of
currently open apps or a daily-active-user metric. The public implementation
increments Total for a successful transition; it does not enforce a lifetime
unique `(installation, release)` count. Rollbacks count reported failures.
See the [metric definitions](https://github.com/microsoft/code-push-server/blob/main/cli/README.md)
and [counter implementation](https://github.com/microsoft/code-push-server/blob/main/api/script/redis-manager.ts).

The actual App Center CLI also requests deployment metrics separately from the
release list and displays `Active`, `Installed`, and `Rollbacks`. Its release
history computes Pending from the same three counters. This confirms the
App Center presentation independently of the standalone server. See
[App Center release history](https://github.com/microsoft/appcenter-cli/blob/master/src/commands/codepush/deployment/history.ts).

For one installation that runs B and then moves to C, CodePush-style B Active
becomes zero. EAS-style B unique users remains one while that visit is inside
the query window. Calling both values `Active` would obscure a material product
difference.

## Read and write behavior

EAS's public GraphQL query asks the server for unique-user totals, cumulative
metrics, and a series. The CLI does not fetch raw event pages to calculate them.
This establishes the public query boundary, not the server's storage cost or
table design. See the [query implementation](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/graphql/queries/UpdateInsightsQuery.ts).

Microsoft's standalone server maintains metrics in Redis hashes. Download and
failure reports increment counters. Successful transitions increment the new
release's Active and successful-install counters and decrement the previous
release's Active. Reads retrieve a deployment's counters with `HGETALL`; their
size grows with releases in that deployment, not raw report history. This is
pre-aggregation, although Hot Updater should further restrict reads to requested
releases. See the [Redis implementation](https://github.com/microsoft/code-push-server/blob/main/api/script/redis-manager.ts).

The newer CodePush reporting path receives the previously reported deployment
and label from the SDK. The native client stores that identity, suppresses an
unchanged successful report, and the JavaScript client retains failed sends for
retry. A previous label in this protocol means the previously reported state;
it is not interchangeable with any event's source bundle. See the
[server route](https://github.com/microsoft/code-push-server/blob/main/api/script/routes/acquisition.ts),
[native telemetry](https://github.com/microsoft/react-native-code-push/blob/master/ios/CodePush/CodePushTelemetryManager.m),
and [client reporting](https://github.com/microsoft/react-native-code-push/blob/master/CodePush.js).

The inspected newer reporting route does not provide event-ID deduplication for its
counter increments. Its Redis `batch()` also does not establish a transaction
with an immutable event log. Hot Updater should retain its existing event-ID
idempotency and native atomic writes rather than copying these limitations.
CodePush's Pending formula is visible in the
[CLI implementation](https://github.com/microsoft/code-push-server/blob/main/cli/script/command-executor.ts).
It is not proof of an exact queue of installations awaiting application when
reports are missing, repeated, or arrive out of order.

## User direction: prefer EAS

### Verified table presentation

The [official production guide](https://expo.dev/blog/the-production-playbook-for-ota-updates)
includes a [screenshot](https://cdn.sanity.io/images/9r24npb8/production/4b34e25c0b12241bb6d25c80b7c3043e10806697-2400x585.png)
of the **Platform-specific updates** table inside update details. Visual
inspection confirms Downloads, Average size, Known launches, and Known crashes;
the last column combines a count and a percentage. It is not the top-level
update-group list. The [adoption documentation](https://docs.expo.dev/eas-update/download-updates/#monitoring-adoption-of-updates)
separately describes a Deployments table and chart with users per update in a
channel/runtime and selected period.

The revised Hot Updater recommendation follows the former table's vocabulary:
Downloads, Known launches, and Known crashes (count plus rate), accumulated over
collected history. Insights uses an explicit selected period, defaulting to seven
days. The row header is Insights, without an All time/Lifetime caption or badge;
removing that caption does not change the cumulative read contract.
Average size is deferred until comparable telemetry
exists. Unique users remains an Insights card. This replaces the earlier
two-value Unique users + Crash rate row suggestion. See the
[revised PRD](./insights-release-activity-prd.md) for Hot Updater's collection
semantics; identical labels do not prove identical telemetry.

### Period semantics

After reviewing both products, the user prefers to follow EAS Update Insights
as closely as practical. The CodePush-style hybrid below is a considered
alternative, not the selected direction. Do not keep current Active merely to
preserve that earlier recommendation.

The public EAS CLI defaults to seven days and accepts explicit start/end bounds.
Its GraphQL query supplies a timespan for unique users and activity metrics.
This does not establish the period of the web platform-specific update rows;
their screenshot has no visible time-range control or explanatory tooltip.
We have not verified whether those row values are lifetime or period totals.
This establishes a period-oriented interface; it does not prove that EAS lacks
internal lifetime aggregates or cannot query a release's full retained history.
See the [default range](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/insights/timeRange.ts)
and [range arguments](https://github.com/expo/eas-cli/blob/main/packages/eas-cli/src/commands/update/insights.ts).

Possible reasons for emphasizing periods, **inferences rather than Expo's
published rationale**, include:

- Recent usage is more useful for judging adoption than historical visits by
  installations that have moved to other versions or stopped reporting.
- Recent failure changes are easier to see without a large denominator of old
  successful launches.
- A bounded interval can constrain partition/index reads and allows a finite
  retention policy, although neither Expo's query plan nor its retention policy
  has been established here.
- Exact unique users cannot be calculated by summing daily unique counts.
  Lifetime uniqueness needs continuing membership information, a distinct query
  over retained identities, or a documented approximation. Bounded periods can
  limit this work but do not automatically make it cheap.

All-time event counts are different: an incrementally maintained counter can
answer them cheaply. Therefore database cost alone does not explain the absence
of a prominent all-time view.

For the EAS-oriented revision, evaluate one explicit observation interval for
both headline measurements and charts. Observed unique installations must not
be labelled as exact current installation assignments. Preserve the prohibition
on raw-history paging and public storage helpers. An indexed or pre-aggregated
read remains necessary even when the selected interval is only seven days.
The latest recommendation answers the earlier all-time request with additive
release-row counters, rather than lifetime unique outcome counts. The user has
selected approximate period Unique users from mergeable summaries. Maintain
channel/platform day summaries so the date-first query does not enumerate
releases. Provider implementation and cost/concurrency still need validation.

### Approved Hot Updater aggregation and UX

Keep the original event log and one added overview store. Maintain release
lifetime counters, release/day summaries, and channel/platform/day summaries
when accepting events. Download, launch, and failure report counters stay exact
for accepted event IDs; derive Crash rate from those counters. Approximate
Unique users uses mergeable HLL-family summaries of successful launch install_id
values, with no exact-membership scan fallback.

The user explicitly requested EAS-style presentation without approximation
notices or precision information. Keep the label Unique users and a plain,
rounded numeric value. Do not add an Estimated badge, tilde prefix, approximation
tooltip, precision percentage, or accuracy setting. Internal accuracy validation
still applies. Missing/failed reads and partial collection remain distinct UI
states, and no copy should claim guaranteed exactness.

This is the chosen Hot Updater contract, not evidence that EAS uses HLL or any
other particular algorithm. The no-overfetching and provider-simplicity
requirements apply to both counters and distinct-count summaries; moving complex
storage logic into a helper does not satisfy them.

### Retained App usage and MAU

Keep Hot Updater's App usage section and its existing 24-hour DAU, seven-day WAU,
and 30-day MAU selections independently of release-health metrics. This is the
rolling count of distinct reporting installations, including no-change and
download reports and installations without an attributed OTA release. It is not
the same population as successful-launch Unique users. Apply the approved
distinct-count summaries separately and keep the ordinary numeric presentation.

The existing App usage implementation reads raw history in 100-event pages with
a 50,000-event ceiling. Keeping its UI does not authorize retaining that path:
the optimized access plan must cover its periods, filters, and existing
distribution requests within the one-overview constraint before delivery.

Expo's [App usage documentation](https://docs.expo.dev/eas-insights/app-usage/)
describes usage insights from update-check requests, with additional metrics
available through expo-insights. Its [billing MAU definition](https://docs.expo.dev/billing/faq/#what-is-an-eas-update-monthly-active-user-mau)
counts installations that download an update within a monthly billing period.
This does not establish the same observation population or rolling window as
Hot Updater's MAU; do not conflate billing usage with release health.

## Previously proposed CodePush-style alternative

The original request favors CodePush-style release rows and EAS-style time
charts. This alternative retains Active's current-state meaning instead of
silently changing it to lifetime unique usage:

- **Active:** installations whose latest accepted observation identifies the
  release as running. Preserve the existing latest-installation access path.
- **Downloaded, Applied, Recovered:** accumulated accepted reports for that
  release. Different event IDs are separate reports; the same event ID is a
  complete no-op. Recovery belongs to the failed source release.
- **Charts:** the same report counters grouped by receipt time over the selected
  range. A range does not change the meaning of the release's headline totals.
- **Unique users:** do not add this metric merely to resemble EAS. Exact
  arbitrary-window uniqueness is a separate requirement; daily unique counts
  cannot be summed into an exact multi-day unique count.

Hot Updater's Applied reports describe update application, not every successful
app launch. Recovered reports describe observed recovery, not every crash.
Keep those labels and do not import EAS's crash-rate formula without a matching
measurement contract.

Use the existing immutable event log and one additional overview table or
collection. Keep existing latest-installation records for their existing query
role and, if Active is retained, its previous/current comparison. This means
one added physical store, not a claim that all Insights storage consists of two
physical tables. Do not disguise installation records as aggregate rows merely
to claim a smaller table count.

The overview can hold one all-time row per release and hourly rows for charts.
An event append and the affected overview updates form two storage
responsibilities, not necessarily exactly two SQL statements. All-time reads
fetch the requested summary keys; range reads additionally fetch only the
requested buckets. No raw-history paging, installation scan, lifetime scan
ceiling, Redis dependency, or public storage adapter is needed for these reads.

For current Active, only a newer installation observation should move the
current counter. Older reports may add report totals but should not launch a
history-reconstruction process. Missing release attribution must remain unknown
unless the latest state supplies unambiguous continuity. The final contract must
state these rules before implementation and test them across providers.

This removes the earlier requirements for lifetime unique downloads/recoveries,
first-outcome markers, marker-retention coupling, and historical attribution
anchors/barriers. Renaming those mechanisms or moving them into a shared helper
would not satisfy the simplification request.

The alternative is EAS-style observed unique installations with no current
Active counter. That is a different product contract and still needs a bounded
deduplication strategy. It must not be presented as two blind counter increments.

## Local Expo source audit: launch failures

Inspected the user-provided Expo checkout at commit
`1c4f3950b5558a1aef6fbaac4c017243fbd101e3` (2026-05-10).
The checkout was read only. This establishes that version's SDK behavior, not
the current hosted EAS aggregation implementation.

The separate expo-eas-client package persists its identity in
[iOS UserDefaults](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-eas-client/ios/EASClient/EASClientID.swift)
and [Android SharedPreferences](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-eas-client/android/src/main/java/expo/modules/easclient/EASClientID.kt).
The downloader includes this value as EAS-Client-ID. This supports reusing Hot
Updater's existing persistent installation identity instead of assigning a new
user identity per startup or adopting the application's optional login ID.

Both [Android's recovery handler](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-updates/android/src/main/java/expo/modules/updates/errorrecovery/ErrorRecoveryHandler.kt#L116)
and [iOS's recovery pipeline](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-updates/ios/EXUpdates/ErrorRecovery.swift#L155)
mark the launched update as failed when a caught startup error occurs before
content appears and the update has no previous successful launch recorded on
that installation. A previous successful launch prevents that failure-marking
branch. This is not a general count of every exception during app usage.

The native content-appeared signal records a successful launch. Error monitoring
can remain for ten seconds after that signal, but that is not a ten-second
success threshold: after content appears, the failure-marking/rollback branch
does not apply. An error may instead trigger a fix-forward check and then crash.
The [official recovery documentation](https://docs.expo.dev/eas-update/error-recovery/)
describes the same distinction. Recovery success is not required before Expo
marks the original update failed locally.

The startup delegate persists the local failed count. Later manifest requests
include [Expo-Recent-Failed-Update-IDs](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-updates/ios/EXUpdates/AppLoader/FileDownloader.swift#L373).
The [database query](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-updates/ios/EXUpdates/Database/UpdatesDatabase.swift#L426)
selects up to five update IDs with a positive failed-launch count, ordered by
update commit time. This request carries recent failed identities, not one
timestamped event per crash or all local counters. Do not infer the server's
deduplication, exact failure-event count, or retention rules from that header.
The five-ID transport bound is unrelated to a seven-day analytics window.

The checkout's [generated GraphQL schema](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/packages/expo-dev-launcher/android/src/debug/graphql/schema.graphqls#L4448)
requires a timespan for update unique users and cumulative launch/failure
metrics. It has no timespan argument on cumulative average payload metrics.
It does not show which range the hosted web table chooses. The repository's
[deployment screenshot](https://github.com/expo/expo/blob/1c4f3950b5558a1aef6fbaac4c017243fbd101e3/docs/public/static/images/eas-update/frontpage/insights.png)
shows a Last 1 Day selector and a Unique Users table, further distinguishing
that period-oriented adoption view from the platform-specific update table.
This is a historical documentation image, not a verified live dashboard.

### Recommended Hot Updater boundary

Use **reported failure to launch an unverified staged update, followed by native
fallback**, as represented by an accepted RECOVERED source release. Keep the
existing event input and do not build another error-reporting subsystem.

Hot Updater's native implementation produces RECOVERED both for an eligible
startup crash marker and for a staged bundle whose local launch files cannot be
resolved. Therefore it supports a launch-failure count, not a strictly
crash-only count. Network/download/hash-verification errors before staging are
not counted. Neither are a normal manual rollback, a downloaded update awaiting
restart, or a generic error after successful content appearance.

An unexpected kill without an eligible crash marker is not evidence of failure.
The Android watchdog schedules recovery only when the crash marker is present;
it must not be interpreted as a startup-timeout failure detector.

Keep Failed launches as the canonical metric. If the row retains EAS's Known
crashes wording, help text must explicitly define it as reported OTA launch
failures, including local launch-file failures. Calling it confirmed process
crashes would require new cause telemetry, which the existing event does not
contain. The current design does not add that telemetry.

## Local custom Expo updates server audit

Inspected the user-provided `custom-expo-updates-server` checkout at commit
`feb29fc4ac1f5eb011bdfe95391190a91da4bb31` (2025-09-17), on 2026-09-20.
The checkout was read only. Its README describes a basic protocol demonstration
and explicitly does not guarantee completeness, stability, or production
performance. It is not the hosted EAS Insights backend.

The server exposes two API handlers:

- `expo-updates-server/pages/api/manifest.ts` selects an update by runtime
  version and platform, then serves a signed manifest or a rollback/no-update
  directive. `expo-current-update-id` is compared with the available update or
  embedded update to decide whether to return `noUpdateAvailable`; the handler
  does not persist or count the observation.
- `expo-updates-server/pages/api/assets.ts` reads and returns an asset file.
  It does not record a download, successful staging, or successful launch.

`expo-updates-server/common/helpers.ts` finds the latest update by enumerating
and sorting local runtime-version directories. Metadata and assets are read
from files. There is no analytics database, event-ingestion endpoint, overview
store, unique-user query, or approximate distinct-count implementation. The
handlers do not consume `EAS-Client-ID` or `Expo-Recent-Failed-Update-IDs`.

This example is useful for understanding update delivery and the meaning of
the current-update header, but it does not resolve the unique-user storage
decision. Do not turn manifest requests, no-update responses, or asset responses
into confirmed launch or staging counts based on this sample. Keep Hot Updater's
existing readiness and verified-staging observations as the measurement source.
Neither exact nor approximate EAS aggregation can be inferred from this repo.

## Implementation status

The product contract now includes EAS-style metrics, write-time overview
aggregation, approximate period Unique users, and plain numeric presentation
without approximation or precision UI. Provider implementation and validation
remain outstanding. This comparison does not claim that the redesign is
implemented, validated, or reflected in the existing PR's E2E results.
