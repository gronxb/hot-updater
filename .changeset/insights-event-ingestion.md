---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"@hot-updater/test-utils": patch
---

`POST /events` follows analytics ingestion practice.

- **Unknown fields:** a report's fields the server does not know are ignored instead of refused with `400`, so a newer SDK's report still records on an older server. Known fields are checked as before, and a body over 16 KB still answers `413`.
- **Idempotency key:** a report may carry `eventId`, a lowercase UUIDv7 the client creates once and repeats on every retry. The server stores the report under it, so a retry counts once; any other `eventId` answers `400`, and a report without one gets a server-created ID as before. An `eventId` another installation already sent answers `409` and changes nothing: the Insights plugin's `recordEvent` throws `InsightsEventConflictError`, now exported from `@hot-updater/plugin-core`, and the published Insights model suite checks it.
- **Back-pressure:** when a transaction runs out of retries (`DatabaseConflictError`) or the database throttles a read, the Insights routes answer `503` with `Retry-After: 5` instead of `500`. Other failures still answer `500`.
