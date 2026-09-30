---
"@hot-updater/aws": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/postgres": patch
---

The PostgreSQL, D1, and Supabase schemas add the Insights update failure counters and sketches, and the `insights_sketches_lifetime` and `insights_failures` tables, under the plugin's schema `1.2.0`, and drop `bundle_event_heads.current_release_id`. The DynamoDB IAM policy covers the two new partitions: rerun `hot-updater init`. A deployment from a 1.0.0 release candidate recreates its database.
