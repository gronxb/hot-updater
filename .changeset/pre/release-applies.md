---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
"hot-updater": patch
"@hot-updater/cloudflare": patch
"@hot-updater/supabase": patch
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
---

Count each release's applies instead of its active days. A release's lifetime counters count its `UPDATE_APPLIED` reports in `applies`, where they counted each installation once for each UTC day it launched the release, and `getReleaseActivity` returns `applies` instead of `launches`. A launch report changes no release or channel counter, and a recovery counts only the crash on the bundle it left, not an apply of the bundle it returned to. The Bundles list and detail show **Applied** instead of **Active days**, and rate known crashes over applied plus known crashes, as Release health does. Hourly and daily counters drop `launches` and `failed_updates`, which no read summed, and a daily launcher costs about 36 DynamoDB write units a day instead of 38.

The Insights schema moves to 1.4.0 in the 1.0.0 baseline. A server, a Console, and a database on different Insights schemas refuse each other, so migrate the database and upgrade both together. On SQL databases, drop the `launches` and `failed_updates` columns of `insights_overview` and `insights_overview_daily`, and rename `launches` on `insights_overview_lifetime` to `applies`, set to 0 (Supabase prefixes these tables with `hot_updater_v1_`); Drizzle and Prisma projects regenerate their schema with `hot-updater db generate` and migrate it. Then set the `schema.insights` setting to `1.4.0`; DynamoDB, Firestore, and MongoDB need only the setting. Applied counts the apply reports received from then on, since the old counts included days an installation only relaunched.
