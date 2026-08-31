---
"@hot-updater/firebase": patch
"@hot-updater/supabase": patch
"@hot-updater/plugin-core": patch
---

Read Firebase event scan batches through native ordered queries instead of
loading the event collection. Prepare bounded cursor queries with exact-value
scope keys and checkpointed index backfill that preserves raw event fields.
Preserve Firestore index field order when merging deployment configuration.

Add an internal Supabase event-page executor and service-role-only JSON RPC,
with bounded lookahead and explicit index readiness. A scalar JSON response
keeps PostgREST row limits from truncating pagination results.
