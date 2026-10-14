---
"hot-updater": patch
---


The CLI writes an `Info.plist` back in the layout Xcode uses. `fingerprint create`, `keys export-public`, `channel set` and `keys remove` rebuilt the plist with the root `<dict>` indented one level under `<plist>`, while Xcode keeps it at column 0, so one key changed every line of the file and dropped its trailing newline. When the existing file has its root at column 0, element lines under `<plist>` now lose that extra tab, and a file whose root is already indented, as 1.0.2 wrote it, stays indented. Text of multi-line values stays as it is and the trailing newline is kept, so writing one key into an Xcode-written Info.plist no longer shifts its other lines. Lines the plist package does not round-trip still change; for example, an empty `<string></string>` becomes `<string/>` and XML comments are dropped.
