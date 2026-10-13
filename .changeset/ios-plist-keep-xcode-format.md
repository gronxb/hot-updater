---
"hot-updater": patch
---

The CLI writes an `Info.plist` back in the layout Xcode uses. `fingerprint create`, `keys export-public`, `channel set` and `keys remove` rebuilt the plist with the root `<dict>` indented one level under `<plist>`, while Xcode keeps it at column 0, so one key changed every line of the file and dropped its trailing newline. Element lines under `<plist>` now lose that extra tab, text of multi-line values stays as it is, and the trailing newline is kept, so an Xcode-written Info.plist only gains or loses the lines of the key that changed.
