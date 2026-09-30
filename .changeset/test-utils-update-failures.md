---
"@hot-updater/test-utils": patch
"@hot-updater/server": patch
---

The Insights suites in `@hot-updater/server/plugins/insights/testing` check update failures. The model suite checks that an update failure is listed in event lists and installation history without moving the latest report, and that a failed check is in no bundle list. The HTTP routes suite records a failure and reads it through `GET /failures`, and `createBundleEventRowFixture` no longer carries `username`. The read-budget suite in `@hot-updater/test-utils` reads a release's and a channel's update failures, over a period and since the release's first report, and its local Insights types follow the new event row.
