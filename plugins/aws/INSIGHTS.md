# DynamoDB Insights storage

`models.insights` implements `record`, `listEvents`, `findInstallations`,
`countInstallations`, and `countEvents`. Core supplies the event and matching
installation candidate. DynamoDB commits the event ID, immutable report, raw
bundle query entry, and winning installation/user rows in one transaction.
Retries preserve the original ID; an accepted ID never mutates state again.

Global history uses the `bundle_events` partition. Installation movement uses
the existing `hot-updater-update-index` GSI and may lag. Bundle history and
counts use a base-table partition keyed by a fixed-length SHA-256 digest of the
exact platform, channel, event type, and raw bundle ID (`from_bundle_id` for recovery, `to_bundle_id` otherwise).
The digest keeps accepted Unicode fields within DynamoDB’s 2 KiB partition-key
limit. These index entries retain existing report fields; there is no outcome
model.
The time range is inclusive at `sinceMs` and exclusive at `beforeReceivedAtMs`;
event cursors are exclusive and order by receipt time and UUID descending.

Installation lookup reads canonical state consistently. User queries validate
candidates against canonical rows and continue after stale associations.
Installation counts query canonical rows in installation-ID order with a native
`COUNT` filter. They read all installation rows, including those outside the
requested scope/window, but never event history. Stable keys prevent a last-seen
update from moving an already counted installation past the cursor. Individual
pages are consistent reads; the whole count is a live traversal, not a frozen
snapshot. Bundle event counts consume every native `COUNT` page of the selected
bundle/time range. Separate count calls do not share a snapshot.

## Initial 1.0.0 schema

The initial table uses `pk`/`sk` and the `hot-updater-update-index` GSI. Managed
AWS initialization provisions that schema. Standalone deployments use the same
schema. All Insights access paths are available immediately: the first `record`
creates the event-ID and bundle query entries in the same transaction as its
canonical report and installation state.

The managed IAM policy includes the Insights partitions. Custom policies must
permit `GetItem`, `Query`, and transaction writes for those partitions and
`Query` for the movement GSI.
