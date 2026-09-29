---
"hot-updater": patch
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
---

The agent setup checklists that `hot-updater agent infra` writes describe a 1.0 release candidate's resources the way the upgrade notes do. The Supabase checklist no longer points to a removed commit RPC migration: release candidate tables and functions are dropped and their migrations marked reverted before the push. The Cloudflare checklist treats a D1 database that recorded `0001_hot-updater_1.0.0.sql` without `schema.engine` as incompatible, and the AWS checklist's DynamoDB leading keys match the policy the scaffold writes.
