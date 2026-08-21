---
"@hot-updater/react-native": minor
"@hot-updater/server": minor
---

Make `baseURL` the only React Native network source. Remove the `resolver` and
client-side `authorityId` options, `HotUpdaterResolver`, its public
parameter/result helper types, and `createDefaultResolver`. Custom GraphQL,
RPC, and other backends must expose the v1 HTTP protocol through an adapter or
proxy and pass that endpoint as `baseURL`.

Report a one-time `console.error` when an app configures both `HotUpdater.init`
and `HotUpdater.wrap`. Use `init + checkForUpdate` for custom or manual update
flows, or use `wrap` for the automatic HOC flow; do not combine them.

Remove authority from the public Release Catalog client paths. Catalog
authority remains server-owned compilation and persistence state, while the
client fetches `/release-catalogs/app-version/:platform/:channelKey/:appVersion`
or `/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`.
