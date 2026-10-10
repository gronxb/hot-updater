---
"@hot-updater/cli-tools": minor
"hot-updater": minor
"@hot-updater/protocol": minor
"@hot-updater/plugin-core": minor
"@hot-updater/server": minor
"@hot-updater/cloudflare": minor
"@hot-updater/react-native": patch
"@hot-updater/expo": patch
"@hot-updater/supabase": patch
"@hot-updater/console": patch
---

Remove code that only served v0. No v1 code called it.

- `@hot-updater/cli-tools` no longer exports the copy-promote helpers `createCopiedBundleArtifacts` and `LEGACY_BUNDLE_ERROR`, or `writeStorageFile` and `writeStorageResponseFile`. Promotion runs through core.
- `hot-updater` no longer exports `getPublicKeyFromPrivate` or `loadPrivateKey`. `hot-updater channel set` help names AndroidManifest.xml, where the channel is written.
- `@hot-updater/protocol` no longer exports `stripBundleArtifactMetadata`, which returned its input.
- `@hot-updater/plugin-core` no longer exports `filterCompatibleAppVersions`.
- `@hot-updater/server` no longer re-exports protocol's `Bundle` type from its root; import it from `@hot-updater/protocol`. `@hot-updater/server/adapters/kysely` no longer exports the `SQLProvider` alias; use `SqlDialect` from `@hot-updater/plugin-core`.
- `@hot-updater/cloudflare` no longer exports `./worker/config` or `./worker/wrangler.json`.
- `@hot-updater/react-native` calls `getBundleId()`, `getManifest()`, and Android's `reloadProcess()` directly, which every v1 native module implements. It no longer reads a `PROMOTED` launch report or manifest assets given as plain strings.
- The Expo config plugin no longer rewrites the `getJSBundleFile` code that its v0 releases injected without a debug check.
- `@hot-updater/supabase/edge` exports `supabaseStorage` directly. The name and config are unchanged.
- The Console drops the unused `getBundles` and `getConfigLoaded` server functions and their query hooks.
