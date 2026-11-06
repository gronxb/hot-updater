---
"hot-updater": minor
"@hot-updater/console": minor
---

The preview action draws the comment's QR codes itself and commits them to the repository's `hot-updater-preview` branch, so a Console on a VPN or Tailscale gets scannable QR codes too.

- The workflow needs `permissions: contents: write`. Without it, the action writes the comment without QR codes, then fails with the permission to add.
- Each pull request's QR codes go to `pr-<number>/` on an orphan branch, named by what they hold, and go when the pull request closes. With `comment: false`, the action writes none.
- "Scan with a phone…" appears only above a QR code. Without one, the comment says to open the sandbox link.
- The project's CLI and its builds no longer get the action's GitHub token.
- The Console no longer serves `/_hot-updater/native-builds/qr` or `/_hot-updater/native-builds/preview-qr`.
