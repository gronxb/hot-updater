---
"@hot-updater/firebase": minor
"@hot-updater/server": patch
"@hot-updater/aws": patch
"hot-updater": patch
---

Run Firestore on the new storage engine. `firebaseDatabase(config)` keeps its signature and gains an optional `collection`.

- **One collection:** every item is a `{ pk, sk, row }` document in `hot_updater_v1`, with a hashed document id. Each index a row belongs to adds a document holding a copy of it, written in the same transaction. Reads use two composite indexes, `pk` with `sk` ascending and descending, and `row` is exempt from single-field indexing. `firestore.indexes.json` is generated from the schema and holds just those.
- **Transactions:** a write is one `runTransaction` that reads only the documents its ops guard. Counters increment without a read, so they hold no read lock: `update` needs the document, so a write whose counter row is missing reruns, reads it, and creates it from `init`. Maps and arrays are stored as JSON text, since Firestore has no nested arrays and does not keep map key order.
- **Schema settings:** the plugin checks the schema settings before its first read and answers 503 until they exist. `migrateFirebaseDatabase(config)` writes them. `hot-updater init` runs it after deploying the indexes, and the agent scaffold's key script runs it through `api-key.config.ts`'s new `migrate` export. Init refuses a project whose `hot_updater_v1_*` collections hold data from a 1.0 release candidate.
- **Init:** merging the project's index overrides with ours now replaces an override for the same field instead of merging the lists by position.
- **Key lengths:** the key-value helper refuses a write whose partition or sort key is longer than the store indexes whole (DynamoDB 2,048 and 1,024 bytes, Firestore 1,500), as `too_large`, instead of failing in the store or truncating the index.
- **Removed:** the Firestore implementation (about 2,100 lines), the adapter version marker, and the channel-id registry documents.
