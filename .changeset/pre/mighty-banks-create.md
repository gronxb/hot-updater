---
"@hot-updater/test-utils": minor
---

Publish the shared Vitest conformance helpers for custom database providers. Register a database lifecycle and a thin HTTP server adapter to verify the database and Release Catalog HTTP contracts with the same scenarios used by official providers and example servers.

Exercise OTA lifecycles with HTTP catalogs and the production client selector: built-in to successive OTAs, rollback to a previous OTA, and return to built-in. Verify selected artifacts, deleted Releases, the native minimum bundle, compatibility, cohort changes, and crash history while retaining device state between checks.
