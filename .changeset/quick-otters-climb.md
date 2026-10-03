---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
---

Show how quickly a release spreads after deployment in an Adoption tab of Release health. With a Release ID selected, it charts the release's download reports in each interval from the hour it was deployed, read from the Release ID's UUIDv7 timestamp, and their running total: hourly for 24h, six hours for 7d, and one day for 30d.

`getReleaseActivity` takes an optional `intervalMs` of whole hours on a release period read and then returns every series point of that span from the period's start; series points also carry `downloads`. It reads the same hourly counters as before, so no schema change, migration, or write is added. The shared model conformance suite covers the hourly series.
