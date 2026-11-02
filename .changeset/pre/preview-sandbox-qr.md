---
"hot-updater": minor
"@hot-updater/console": minor
---

The preview action works with a sandbox scheme. It finds the sandbox build by fingerprint on `sandbox-<scheme>`, builds only when there's none, deploys the pull request's bundle to its own channel, and comments the install link and a QR code of the sandbox link.

- `android-fallback-scheme` and `ios-fallback-scheme` name a normal scheme to build on the pull request's channel when its native code differs from every sandbox build. Without one, the action builds a new sandbox build.
- `android-sandbox-link` and `ios-sandbox-link` are new outputs. A user with no sandbox scheme gets the same comment and outputs.
- `native-build find --json` adds `sandbox`, for a sandbox scheme only: `appId` and `otherBuilds`.
- The Console serves `/_hot-updater/native-builds/preview-qr`, which takes a link's app ID, channel and fingerprint, reads nothing, and only ever holds a sandbox link.
