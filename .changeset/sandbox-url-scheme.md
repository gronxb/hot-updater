---
"@hot-updater/plugin-core": patch
"@hot-updater/protocol": patch
"@hot-updater/cli-tools": patch
"@hot-updater/apple-helper": patch
"@hot-updater/android-helper": patch
"@hot-updater/server": patch
"@hot-updater/react-native": patch
"hot-updater": patch
---

Set a sandbox build's URL scheme on its scheme: `sandbox: { urlScheme: "acme-preview" }` in `hot-updater.config.ts` turns the sandbox on with that scheme, and `sandbox: true` keeps `hu-sandbox-<app ID>`. The config refuses a scheme that isn't lower case URI syntax of up to 64 characters, or is `http`, `https`, `file`, `data` or `javascript`, and the build refuses one the app registers itself.

The build registers the scheme in its sandbox URL type on iOS and on the sandbox activity on Android, which also names it in `com.hotupdater.sandbox.URL_SCHEME`, and the scheme is part of the native build key. Import and registration read it from the artifact into the registry's new `native_builds.sandbox_url_scheme`, `native-build find --json` returns it as `sandbox.urlScheme`, and the preview action's link and QR code use it, so a reused build keeps the scheme it was built with. A sandbox build accepts only its own scheme's links: another scheme's link "isn't a link for this app". Builds registered before the column read as the derived scheme.

The column is part of the 1.2.0 migration. A database a 1.2 prerelease migrated needs it added by hand: `ALTER TABLE native_builds ADD COLUMN sandbox_url_scheme TEXT` on D1, and `ALTER TABLE hot_updater_v1_native_builds ADD COLUMN sandbox_url_scheme varchar(255) COLLATE "C"` on Supabase.
