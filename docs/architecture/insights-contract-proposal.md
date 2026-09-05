# Insights database contract

Status: accepted, 2026-09-05. Implemented in PR #1236.
See [Built-in Insights](./insights.md) for the product API and deployment notes.

The goal is useful operational diagnosis and deployment evidence with a small,
explicit contract for custom database authors. The plugin-author review and
adversarial review agreed to use record/list/find/count operations, comparable
to the existing models. Product summaries belong to the shared Insights core.

## 1. Product scope

| Question                                        | Core uses                                     | Product answer                                                  |
| ----------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Which installations reported recently?          | `countInstallations`                          | Reporting-installation count for a platform/channel and window  |
| Is a selected bundle being reported?            | `countInstallations` with `bundleId`          | Installations whose last report names that bundle               |
| Is that bundle being applied or recovered from? | `countEvents` for each outcome type           | Applied, recovered-from, and adopted report counts for a period |
| What happened to this installation/user?        | `findInstallations`, `listEvents`             | Last reported state and bundle movement history                 |
| Which reports explain a count?                  | `listEvents` with the same bundle/time filter | The underlying outcome reports                                  |
| What reports are arriving?                      | `listEvents` with the all-events filter       | Global event history                                            |

Core supplies 24h, 7d, or 30d windows. Counts concern reporting installations
and accepted reports, not all installed devices, concurrent users, or unique
update attempts. Offline apps, opt-outs, and unsuccessful SDK sends are absent.
A recovery report is not a count of every crash or download failure.

The selected bundle and whole scope are independent live measurements. The
basic UI shows those counts independently, without dividing them into an exact
share or calling the result deployment completion. The scope may also contain
native versions and cohorts ineligible for the selected Release.

Top-N distribution, `Other`, same-snapshot percentages, and mandatory time-series
charts are outside this contract. These were additional requirements in the
earlier proposal, not necessary to support the two product purposes above.
A period comparison can use additional explicit count calls; core must not
silently restore a 30-bucket chart through 90 count calls.

## 2. What a provider implements

```ts
import type {
  BundleEventRow,
  InsightsInstallationRow,
} from "@hot-updater/plugin-core";

type Scope = {
  readonly platform: "ios" | "android";
  readonly channel: string;
};

type BundleEventFilter = Scope &
  (
    | {
        readonly type: "RECOVERED";
        readonly fromBundleId: string;
      }
    | {
        readonly type: "UPDATE_APPLIED" | "RELEASE_ADOPTED";
        readonly toBundleId: string;
      }
  );

type EventFilter =
  | { readonly kind: "all" }
  | { readonly kind: "installationMovement"; readonly installId: string }
  | ({ readonly kind: "bundle" } & BundleEventFilter);

type EventKey = {
  readonly receivedAtMs: number;
  readonly id: string;
};

type InstallationQuery =
  | { readonly installId: string }
  | {
      readonly userId: string;
      readonly afterInstallId?: string;
      readonly limit: number;
    };

interface InsightsModel {
  record(input: {
    readonly event: BundleEventRow;
    readonly installation: InsightsInstallationRow;
  }): Promise<void>;

  listEvents(input: {
    readonly filter: EventFilter;
    readonly sinceMs?: number;
    readonly beforeReceivedAtMs: number;
    readonly after?: EventKey;
    readonly limit: number;
  }): Promise<readonly BundleEventRow[]>;

  findInstallations(
    input: InstallationQuery,
  ): Promise<readonly InsightsInstallationRow[]>;

  countInstallations(
    input: Scope & {
      readonly sinceMs: number;
      readonly bundleId?: string;
    },
  ): Promise<number>;

  countEvents(input: {
    readonly filter: BundleEventFilter;
    readonly sinceMs: number;
    readonly beforeReceivedAtMs: number;
  }): Promise<number>;
}
```

All calls take objects. For example, `findInstallations({ installId })` finds
one installation; `findInstallations({ userId, afterInstallId, limit })` pages
that user's installations. Mixing the two query forms is invalid. No generic
query language or arbitrary combinations of predicates are required.

### record: persist one prepared report

Core prepares the event and latest-installation candidate. They must describe
the same report; shared boundary validation checks this before provider I/O.

The provider atomically inserts the immutable event and advances the installation
row only when the candidate's `(received_at_ms, id)` is greater. There is one
latest row per installation. This is full replacement of the winning state,
including clearing an old user association when `user_id` becomes `null`.
An older report remains in event history but cannot regress current state.

The event ID is the idempotency key. The caller preserves the complete prepared
input across retries. A duplicate ID does not overwrite the stored event or
perform another installation update; the first accepted report wins. Generating
a new ID inside a native retry is forbidden. Core owns ID generation and must
not reuse an ID for a different report.

Success means both canonical records are durably committed. A known rollback
leaves neither change. A lost connection during commit can leave the outcome
unknown; retrying the identical input remains safe. No new repair job, outcome
table, or independently maintained analytics counters are required.

Atomicity is retained because separate event/snapshot writes can fail halfway
and remain inconsistent permanently when the best-effort SDK never retries.
Bundled providers implement this with native transactions, transactional
batches, or RPCs. The internal adapter delegates to `recordInsights`; it does
not derive atomicity from sequential CRUD.

Secondary indexes may reflect a committed write later. Atomic canonical storage
does not require manually duplicating every index entry inside the transaction.

### listEvents: list a bounded, ordered range

`listEvents` is the chosen name; cursor pagination remains part of its behavior.

Order is descending `(received_at_ms, id)`. Rows must satisfy
`(sinceMs ?? 0) <= received_at_ms < beforeReceivedAtMs`.
The optional `after` key is exclusive and selects strictly smaller keys.
Core validates the range and binds its opaque HTTP cursor to the filter and
time bounds. Providers receive only the decoded ordering key.

Provider limits are integers from 1 through 101. Core requests one lookahead
row and returns at most 100 to the caller. Apply filters before the limit.
Return the first `min(limit, matching visible rows)` rows. A short native page
with a continuation token is not exhaustion; continue or surface the error.
Never turn a query failure into a short successful page.

Only three access patterns are required:

- `all`: global event order.
- `installationMovement`: that installation's `UPDATE_APPLIED` and
  `RECOVERED` events in event order.
- `bundle`: the supplied raw event type, platform/channel, and from/to bundle
  equality conditions, in event order.

The movement predicate is defined once in shared code and covered by public
tests. A provider may use its existing movement index or a fixed two-range
query and merge. It must not scan lifecycle reports and discard `UNCHANGED`
rows until a page fills. Full per-installation lifecycle history is not an
additional mandatory access path.

Use indexed cursor ranges without walking preceding pages or loading the
history first. Counts and lists share the same bundle predicate construction,
so a count's drill-down describes the same records.

### findInstallations: exact last-reported identity

An installation-ID query returns `[]` or a one-row array using an exact lookup.
Core converts that result to the public product API's `row | null` if needed.

A user-ID query returns only installations whose latest `user_id` matches.
Order is installation ID ascending; `afterInstallId` is exclusive and limits
are 1 through 101. The complete-prefix rule from event lists also applies here.
Historical users and usernames are not matches.

The canonical installation lookup must observe acknowledged writes. User-index
membership may lag: providers using a lagging index must check candidates
against canonical installation state and discard rows assigned to another user
before applying the result limit. Continue the native cursor after discarding
stale candidates; do not turn them into false exhaustion. New associations may
temporarily be missing while the index catches up. Concurrent identity changes
can alter later pages; this is not a frozen search result.

### countInstallations: one scalar over latest state

Count installation rows whose platform/channel matches and whose
`received_at_ms >= sinceMs`. When `bundleId` is supplied, also require
`to_bundle_id = bundleId`. Each installation contributes at most once within
the call. Event history is never the source of this count.

Use a native aggregate with appropriate consistency, or traverse canonical
installation rows with a stable installation-ID cursor. Paging a mutable
last-seen index must not count an installation again when it moves to a newer
key. There is no cross-call snapshot guarantee and no historical reconstruction
at `sinceMs`; it is a lower freshness bound on last-reported state.

This returns one number, not groups, top-N rows, percentages, or chart data.
Providers without a suitable native aggregate may need to inspect all stored
installation rows, not just rows inside the requested window. That cost must
be documented rather than hidden behind the small return value.

### countEvents: one scalar over a fixed event filter

Count events matching the supplied `BundleEventFilter` and the half-open
receipt-time interval `[sinceMs, beforeReceivedAtMs)`.

Core chooses the filter using this rule:

| Product counter        | Type              | Bundle equality  |
| ---------------------- | ----------------- | ---------------- |
| Applied reports        | `UPDATE_APPLIED`  | `to_bundle_id`   |
| Recovered-from reports | `RECOVERED`       | `from_bundle_id` |
| Adopted reports        | `RELEASE_ADOPTED` | `to_bundle_id`   |

For recovery from B to A, core asks for `RECOVERED/fromBundleId=B`; the latest
installation candidate names A. Providers apply the supplied raw equality
conditions and do not invent a recovery-attribution rule. No new outcome
columns or outcome classification records are needed.

Counts are accepted report counts, not unique installations or unique attempts.
`UNCHANGED` does not contribute to these counters. A normal native count query
or native count-page loop is sufficient; no buckets or report publication
protocol are required. All native pages must be counted, or the call fails.

## 3. Shared rules and ownership

| Shared Insights core                                       | Database provider                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| Authentication, input normalization, event ID/receipt time | Durable event storage and conditional latest-state write     |
| Preparing the installation candidate                       | Atomicity, idempotency, native transaction retries           |
| Movement definition and selecting raw bundle predicates    | Translating the fixed predicates into native queries         |
| Date windows, cursors, HTTP responses, product labels      | Native pagination, indexes, scalar counts, error propagation |
| Shared validation and provider conformance tests           | Actual backend prerequisites and query-cost evidence         |

Rows mean the last report received by the server, not a guaranteed live device
state. Receipt time is not device occurrence time; a delayed report can become
the latest received report. The ingestion protocol still creates a new event
ID per HTTP request: storage idempotency is not exactly-once SDK delivery.

IDs are exact and case-sensitive. Event IDs are canonical ASCII UUIDv7.
Installation IDs use UTF-8 byte order without case folding or normalization;
core cursor comparisons and provider collation must agree. Shared validation
rejects malformed Unicode. Existing row/field and 16 KiB ingestion limits
remain. Timestamps and counts are non-negative safe integers.

Query failures propagate. Empty results and zero counts only represent
successful empty queries; partial counts are not returned as success. Core
owns validation and HTTP error mapping; providers translate native failures
without needing an Insights-specific error framework of their own.

The public constructor's shared validation cannot prove atomicity, completeness,
or index usage from a return value. Public conformance tests and native query
evidence establish those behaviors.

## 4. What becomes simpler, and what still costs work

The two summary methods are removed from the provider contract. So are top-N
grouping, `Other`, selected-bundle special result fields, bucket generation,
new outcome records, and universal immediate secondary-index visibility.
`findInstallations` uses the two explicit object forms above.
The contract still has five operations because it supports five storage tasks;
a single generic `query` method would only conceal their implementations.

Retained costs and limitations:

- Atomic event/latest-state writes still require a native transaction or
  equivalent conditional atomic primitive. Existing generic sequential CRUD
  is insufficient. MongoDB transaction prerequisites and each provider's real
  batch/RPC path must be checked before claiming compatibility.
- Bundle event queries need from/type/scope/time and to/type/scope/time access
  paths. Reusing existing raw fields avoids new attribution semantics, but
  building indexes or populating DynamoDB index-key attributes on old rows may
  still require a migration. Migrations preserve existing data; no data reset is part of this contract.
- The existing movement-only access path can stay. Do not expand it to every
  installation event/filter combination just to make the API more generic.
- Secondary-index reads may lag. A fixed receipt cutoff is not a commit
  watermark either: in-flight or newly visible reports can appear on refresh
  after a cursor has passed them. Stable, converged data must be completely
  traversable beyond 50,000 events.
- User lookup through a lagging index needs canonical candidate checks. Stale
  membership can increase reads before a valid page fills; failures still reject
  rather than return a partial page as complete. A native current-user query
  over canonical storage does not need that extra index-validation step.
- Scalar counts can inspect many records. Installation counts read latest
  state; event counts use the selected scope/type/bundle/time range. Returning
  one number does not promise constant database work or fixed latency.
- Counts from different requests describe independent live views. Core returns
  measurement times and does not manufacture a precise ratio, clamp mismatched
  measurements, or silently sum partial results.

This limits mandatory product-specific implementation. It does not promise
that every current provider can add the new access paths without code or
storage changes. Existing native storage helpers should be reused where they
fit; no new universal CRUD layer is required for a custom provider.

## 5. Acceptance and implementation

The plugin-author and adversarial reviews agreed on the narrowed contract.
The counterarguments retained here are material: scalar counts still cost I/O,
separate counts cannot establish an exact share, moving count cursors can
duplicate installations, and non-atomic writes need a real repair mechanism.

Public provider tests must cover:

| Scenario                                                                   | Required result                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Identical prepared report is retried after success or ambiguous commit     | One event; no duplicate state mutation                                                      |
| Native failure between event insert and installation update                | Atomic rollback; no partial canonical state                                                 |
| Concurrent reports, including timestamp ties                               | All distinct events persist; greatest ordering key owns latest state                        |
| User changes or becomes anonymous; an older report arrives later           | Only winning identity is canonical; old reports do not restore it                           |
| B is applied, then recovered to A                                          | Applied/recovered counts belong to B; latest state names A                                  |
| Same-bundle Release adoption                                               | Adoption count advances without an application count                                        |
| Global and movement history exceed 50,000 rows with sparse movement events | Complete stable-data traversal, filter before limit, no preceding-page scans                |
| Native short/empty page has continuation                                   | Continue fetching; no false exhaustion                                                      |
| Report lies on a time boundary                                             | Inclusive lower/exclusive upper, same predicate for list and count                          |
| Exact install/user object queries, mixed-case and Unicode IDs              | Correct identity, cursor order, and cardinality                                             |
| User index retains an old association or has not added a new one           | Reject old-user candidates after canonical checks; new membership may be temporarily absent |
| Latest-state count traverses concurrent updates                            | An installation is not counted twice through a moving cursor                                |
| Empty storage versus query error                                           | Zero/empty for the former; failure for the latter                                           |

The public custom-provider guide and exported JSDoc define the same contract.
Native provider tests supplement shared conformance with rollback, continuation,
migration, and indexed-range evidence. Functional tests alone do not establish
a deployment-specific latency or throughput guarantee.
