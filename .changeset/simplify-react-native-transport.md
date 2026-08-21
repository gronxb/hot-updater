---
"@hot-updater/react-native": minor
"@hot-updater/server": minor
---

Make `baseURL` the only React Native network source. Remove the `resolver` and
client-side `authorityId` options, `HotUpdaterResolver`, its public
parameter/result helper types, and `createDefaultResolver`. Custom GraphQL,
RPC, and other backends must expose the v1 HTTP protocol through an adapter or
proxy and pass that endpoint as `baseURL`.

Remove authority from the public Release Catalog client paths. Catalog
authority remains server-owned compilation and persistence state, while the
client fetches `/release-catalogs/app-version/:platform/:channelKey/:appVersion`
or `/release-catalogs/fingerprint/:platform/:channelKey/:fingerprintHash`.
