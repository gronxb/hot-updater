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

## Upgrading existing Insights data

Pause ingestion before upgrading old writers or running this migration. Keep it
paused until the migration succeeds and every writer runs the new version. Old
writers cannot maintain the new query indexes. Do not delete or reset data.

Managed AWS initialization runs `migrateDynamoDBInsights` after ensuring the table.
For an existing standalone DynamoDB table, run the same exported migration using
the AWS credential chain and the region/table name of the deployment:

```sh
AWS_REGION=ap-northeast-2 HOT_UPDATER_DYNAMODB_TABLE=your-table node --input-type=module <<'JS'
import { migrateDynamoDBInsights } from '@hot-updater/aws';
await migrateDynamoDBInsights({
  region: process.env.AWS_REGION,
  tableName: process.env.HOT_UPDATER_DYNAMODB_TABLE,
});
JS
```

Supply `endpoint` in the configuration for a standalone local DynamoDB service.
Explicit `credentials` are also accepted. The operation needs `GetItem`, `Query`,
`PutItem`, and transaction write permissions for the table's Insights partitions.
Updated managed IAM policy includes these partitions; custom policies must do so.

Migration traverses the existing event partition with bounded pages and adds
only ID and bundle query entries. It preserves the canonical event and latest
installation rows. Each event's entries commit together. If it fails, rerun the
same command: accepted entries are skipped and completion is marked only after
the full traversal. Conflicting historical reuse of an event ID stops migration
with an error instead of picking a winner or deleting a report.

An empty event partition initializes its readiness marker with bounded metadata
queries. A populated legacy partition without the completed marker rejects new
records and bundle list/count operations with the migration instruction, so
missing index entries cannot silently appear as zero reports. Global history
and canonical installation queries remain readable during preparation.
