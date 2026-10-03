---
"@hot-updater/cli-tools": minor
"@hot-updater/protocol": minor
"@hot-updater/react-native": minor
"@hot-updater/server": minor
"@hot-updater/plugin-core": minor
"@hot-updater/bare": minor
"@hot-updater/expo": minor
"@hot-updater/rock": minor
"@hot-updater/supabase": patch
"hot-updater": minor
---

Require build integrations to declare their complete artifact inventory, final
portable names, per-asset `downloadCompression`, and `patchAssetPath`. Snapshot
declared regular files before hashing, compression, upload, and archive creation;
reject traversal, symlink, mutation, reserved-name, entry-limit, and portable
path collisions. Apply shared 128 MiB archive and per-artifact limits, a 512 MiB
expanded limit, and a 1 MiB signed-manifest limit, with deterministic portable
path and fingerprint-input ordering. Normalize archive entry order, timestamps,
and modes; make promotion revalidate archive structure, manifest coverage, and
asset hashes before repackaging; and detect source mutation during native
fingerprint hashing.
Never rollback-delete shared content-addressed promotion assets; retain them until
a future cleanup operation can prove ownership and the absence of references
atomically.

Persist explicit patch and download-representation metadata in signed manifests
and serve delta descriptors without inferring an engine from `.bundle`, `.hbc`,
or `index.*` filenames. Promotion preserves explicit raw or Brotli assets.
Manifest-v1 delivery requires authenticated manifests and explicit download
representations; optional tar.br archives exclude the manifest and use its
declared transfer hash and sizes.

Move React Native/Hermes artifact selection and default fingerprinting into
`@hot-updater/react-native`, with the bare and Rock integrations using that
provider. Move Expo fingerprint source discovery into the Expo integration.
Build plugins may also own native signing-key discovery. Common Hot Updater,
server, storage, and promotion code now consume engine-neutral declarations.

Keep the server entry portable across Deno and plain Workers: expose Node.js
filesystem fingerprint helpers through `@hot-updater/plugin-core/fingerprint`
and use portable SHA-256 for manifest authentication. Preserve package subpaths
when generating versioned npm imports for Supabase edge functions.
