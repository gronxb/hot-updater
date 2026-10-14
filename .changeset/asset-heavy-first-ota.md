---
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/plugin-core": patch
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/server": patch
"@hot-updater/test-utils": patch
---

Make the first OTA of an asset-heavy app fast (#1549).

- Artifact protocol v2: `GET /artifacts/v2/:target/from/:current` signs only the manifest, archive, and Hermes patch URLs. The app then asks `POST /artifacts/v2/:target/files` for just the files it downloads one by one, after reusing local and built-in files and choosing the archive. Signing and the response no longer grow with a Bundle's file count, on every storage. Redeploy the server to serve v2; until then the SDK falls back to `/artifacts/v1`, which apps on older SDKs keep using.
- `cloudFrontDownloadUrl` signs one CloudFront policy for a Bundle's files and one for the shared assets, instead of one RSA signature per file.
- `firebaseStorage` reuses each object's signed URL until half its lifetime has passed, instead of a `signBlob` request per file on every update check.
- The app downloads up to 16 files at once, and takes the Bundle's archive when the files left would cost more in requests than the archive's extra bytes.
- On Android, the native build records each asset's source hash, so the first OTA reuses built-in PNGs that the release build re-encoded (AAPT2 crunch) instead of downloading them.
