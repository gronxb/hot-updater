---
"@hot-updater/plugin-insights": patch
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
---

Show how quickly a release spreads after deployment in an Adoption tab of Release health. It charts the chosen release's download reports in each interval from the hour it was deployed, read from the Release ID's UUIDv7 timestamp, and their running total: hourly for 24h, six hours for 7d, and one day for 30d. Choose the release in the tab's Chart bundle list of releases observed in the period, newest deployment first, or with Chart newest bundle; or open View adoption from a bundle's Insights card, which picks the shortest period that covers its deployment. The open Release health tab is kept in the URL, the card stays in place while a new bundle or period loads, and an empty chart offers the period that covers the deployment.

`getReleaseActivity` takes an optional `intervalMs` of whole hours on a release period read and then returns every series point of that span from the period's start; series points also carry `downloads`. It reads the same hourly counters as before, so no schema change, migration, or write is added. The shared model conformance suite covers the hourly series.
