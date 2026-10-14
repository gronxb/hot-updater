---
"@hot-updater/aws": patch
"@hot-updater/firebase": patch
"@hot-updater/react-native": patch
---

Make the first OTA of an asset-heavy app fast (#1549).

- `cloudFrontDownloadUrl` signs one CloudFront policy for a Bundle's files and one for the shared assets, instead of one RSA signature per file, so an update check with hundreds of assets no longer times out on Lambda@Edge.
- `firebaseStorage` reuses each object's signed URL until half its lifetime has passed, instead of a `signBlob` request per file on every update check.
- The app downloads up to 16 files at once, and takes the Bundle's archive when the files left would cost more in requests than the archive's extra bytes.
- On Android, the native build records each asset's source hash, so the first OTA reuses built-in PNGs that the release build re-encoded (AAPT2 crunch) instead of downloading them.
