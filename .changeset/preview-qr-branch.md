---
"hot-updater": minor
"@hot-updater/console": minor
---

The preview comment works in two steps: install the app, then, on a sandbox build, scan the QR code that opens the pull request.

- Each platform's native build gets one line of install links: Download APK, Install on iPhone, or its own store's link and state, then Details. Native builds have no QR code. Build IDs, fingerprints, and bundles move into a collapsed Builds table.
- The sandbox link's QR code is the only QR code. The action draws it and commits it to the repository's `hot-updater-preview` branch, so a Console on a VPN or Tailscale gets one too. The workflow needs `permissions: contents: write`; without it, the action writes the comment with the link and no QR code, then fails with the permission to add. With `comment: false`, it writes none.
- "Scan" appears only above a QR code.
- The project's CLI and its builds no longer get the action's GitHub token.
- The Console no longer serves `/_hot-updater/native-builds/qr` or `/_hot-updater/native-builds/preview-qr`.
