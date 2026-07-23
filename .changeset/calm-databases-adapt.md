---
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/test-utils": minor
"@hot-updater/aws": minor
"@hot-updater/cloudflare": minor
"@hot-updater/firebase": minor
"@hot-updater/mock": minor
"@hot-updater/postgres": minor
"@hot-updater/standalone": minor
"@hot-updater/supabase": minor
"@hot-updater/cli-tools": minor
"@hot-updater/console": minor
"@hot-updater/core": minor
"@hot-updater/react-native": minor
"hot-updater": minor
---

Replace the legacy database plugin API with the fixed-model plugin API for
`bundles`, `bundle_patches`, and `bundle_events`. Database providers now return
a direct plugin object, aggregate bundle behavior is provided by the shared
database client, callback transactions and optimized update checks are optional
capabilities, and the v1 staged mutation API has been removed. Provider
functions now receive their configuration directly and close over it inside
`createDatabasePlugin({ name, plugin })`.

Database plugin operations no longer receive request context. Providers close
over their configured database client or binding, while request context remains
available to server handlers and storage plugins for request-scoped URL and
authorization behavior. Multi-tenant servers must resolve the tenant at a
trusted server boundary and select a separately configured runtime and database
plugin for that tenant. There is no compatibility adapter for the v1 factory,
request-context, unit-of-work, or `commitBundle` contracts.

The mock provider replaces `initialBundles` with fixed-row
`MockDatabaseData`. Create it with `createMockDatabaseData()` and populate the
bundle, patch, and event maps before passing it to `mockDatabase({ data })`.
`onUnmount` remains an implementation cleanup hook; cache invalidation belongs
to the returned plugin's `onDatabaseUpdated` lifecycle.

Keep channel names directly on `bundles.channel` without introducing a channel
model, table, collection, or foreign key. Plugins may expose an optimized
`getChannels` aggregate, while the shared database client falls back to paging
bundle channel values and returning their sorted distinct set.

Publish `@hot-updater/test-utils` with reusable low-plugin and aggregate-client
conformance suites for custom database plugin authors.

Expose app-ready Analytics for record plugins and proxy event ingestion,
active-installation overview, bundle outcomes, installation search, and
installation history through the standalone repository. React Native reports
unchanged launches as well as applied/recovered transitions through a dedicated
best-effort Analytics transport while preserving the existing readiness
callback. The Console aggregates active installations by install ID, supports
exact user-ID alias filtering, and keeps received-report activity, transition
outcomes, and configured rollout semantically separate.

The shared database client pushes the requested owner page and stable ordering
into the provider, counts separately, and hydrates only selected owners and
referenced base bundles. Bundle updates forward only caller-present scalar
fields. Omitted patches stay unchanged; caller-present patch replacement
requires a real provider transaction and throws
`DatabasePatchUpdateUnsupportedError` before mutation when that capability is
absent.

The MongoDB adapter exposes that transaction capability when configured with
`transactions: true`. Use it with a replica set or sharded cluster so bundle
and patch-row replacements commit atomically.

Core bundle artifact helpers prefer normalized `bundle_patches` rows over
deprecated scalar patch fields when both representations are present.

Multi-platform deploy now performs build, archive, and content-addressed upload
work once before entering a retryable database transaction. The transaction
callback contains repeatable database inserts only. Uploaded objects remain
available for reuse when the database commit fails.

Client event ingestion is mounted automatically when the configured database
supports Analytics. The managed Cloudflare, Firebase, and Supabase presets
therefore mount `POST /events` by default so mobile Analytics works without
additional server configuration. This release does not add route-specific
authentication; event payloads remain untrusted telemetry and deployments are
responsible for their framework or provider access controls, rate limits,
quotas, logging, and retention.

Analytics and installation query routes are also closed by default. Self-hosted
servers expose them explicitly with `routes.analytics: true`, independently
from bundle management routes. Event ingestion is independent of that query
flag and follows database Analytics support automatically.

`GET /version` now distinguishes structural database Analytics support from
the mounted routes through `capabilities.analytics`,
`capabilities.eventIngestion`, and `capabilities.analyticsQueries`.
Standalone and Console require the query-route capability and conservatively
treat legacy responses without route fields as unavailable.
Standalone preserves the upstream ingestion and query flags independently and
returns 404 instead of forwarding a route that the upstream reports disabled.
It caches validated upstream route capabilities for 30 seconds, coalesces
concurrent refreshes, and uses the last validated response for at most five
minutes before failing closed. Proxied event ingestion preserves the validated
SDK-version header.

The managed Firebase runtime forwards the original request bytes into the
shared server handler so the Analytics payload limit applies before parsed JSON
can be normalized.

Snapshot-backed plugins created with `createBlobDatabasePlugin`, including
`s3Database`, deliberately leave Analytics disabled because concurrent event
writes can conflict. The Console hides Analytics based only on capability
presence, without provider-name branching.

React Native preserves the legacy `resolver.notifyAppReady` readiness callback
independently from Analytics and adds `resolver.notifyAppReadyAnalytics` for
best-effort event transport. New JavaScript preserves recovery reported by an
older native binary; if the native payload lacks the directional metadata
needed for an Analytics event, only telemetry is skipped. Roll out the native
binary before enabling Analytics through JavaScript OTA.

Official providers no longer silently ignore distinct counts, `distinctOn`, or
multi-clause ordering. Supported distinct operations are exact, and providers
honor every requested order clause. Callers must request an `id` clause when
they need a deterministic tie-break. Unsupported operations reject with a
typed error before provider I/O.

Blob database mutation success follows the active-pointer commit. Post-commit
cache invalidation is attempted up to three times. Exhaustion calls
`BlobDatabaseOperations.onInvalidationError` once with the attempted paths and
error, but does not report the committed database mutation as failed.
`onDatabaseUpdated` still runs once after committed success.

Cloudflare's `./worker` export is Worker ESM-only. CommonJS `require` and
fallback conditions are no longer advertised.

Schema migrations are forward-only and do not include automatic down
migrations. Back up each provider before upgrading and publish the compatible
Hot Updater package cohort together. Roll back code against the newer schema
only when that package set is documented as compatible; otherwise stop writers
and restore the pre-migration backup. Configure provider-native retention for
`bundle_events`, which are not deleted with bundles.
