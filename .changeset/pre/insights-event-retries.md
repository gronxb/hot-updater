---
"@hot-updater/react-native": patch
---

Retry Insights reports, give each one an `eventId`, and keep debug builds out of production Insights.

- **Retries:** a report that fails with a network error, a timeout, `429`, or a `5xx` is retried in the background, up to three attempts in all: about 1 s and then 2 s apart with jitter, or after the server's `Retry-After`, capped at 30 s. Each attempt keeps its own `requestTimeout`; any other status, such as `400`, is not retried. Startup, `onNotifyAppReady`, and `updateBundle()` still wait at most for a first attempt, never for a backoff. Reports leave one at a time in order, so a retried `UPDATE_APPLIED` cannot land after a later `UPDATE_DOWNLOADED`, and a warning is logged when a report is dropped.
- **`eventId`:** every report carries a client-generated UUIDv7 `eventId`, the same on every attempt, so a server that deduplicates on it counts a retried report once. A server that rejects unknown payload keys answers `400` and the report is dropped, so upgrade `@hot-updater/server` with the SDK; an adapter that implements `POST /events` itself must accept or ignore the key.
- **Debug builds:** when `__DEV__` is `true`, `HotUpdater.init` and `HotUpdater.wrap` send no Insights reports unless `insights: { debug: true }` is set. `insights: false` still turns reporting off everywhere, and `{ debug: true }` behaves like `true` in a release build.
