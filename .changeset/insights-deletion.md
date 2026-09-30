---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"@hot-updater/standalone": patch
"@hot-updater/test-utils": patch
---

Delete one installation's or one user's Insights data. `insights()` adds `api.insights.deleteInstallation(installId, { limit })` and `api.insights.deleteUser(userId, { limit })`, and the admin routes `DELETE /installations/:installId` and `DELETE /installations?userId=<id>`. They delete an installation's downloads, applies, and recoveries, then its latest report and the distributions that count it; deleting a user deletes every installation whose latest report names that user. Each call deletes a bounded batch and answers `{ deleted: { installations, events }, complete }`; repeat it until `complete`. Totals and unique-installation sketches hold no identifiers and stay until they age out. `RemoteDatabase.fetchAdmin`, and `standaloneRepository`'s, take an optional `{ method, body }`. The database test suite's Insights routes check both deletions on every provider.
