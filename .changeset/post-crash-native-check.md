---
"@hot-updater/react-native": minor
---

After a crash that doesn't roll back, check for a fix natively, so a bundle that crashes in its own update flow can be replaced (#1619).

- A crash after the first render still doesn't roll back. The bundle may have changed stored data by then, and Expo Updates keeps the same rule. Until now, though, such a bundle could trap a device: when it crashed inside the app's update flow, its JavaScript never got far enough to download a fix.
- Main now records a crash at any point of the process, not only up to 10 seconds after the first render. After a crash that didn't roll back, the next launch that shows UI checks for an update natively in the background, and whatever it finds applies at the launch after that. A new bundle's crash before its first render still rolls back locally, with no check. Deploy a fixed bundle, or disable the bad Release so the server rolls devices back, and a crashing device recovers within two restarts.
- `init` and every update check save their server, headers, timeout, and update strategy on the device, through the existing `setStorageItem` bridge, for that native check. A device that never ran `init`, for example one deferring it until the user accepts the privacy terms, sends no request. A launch that didn't crash sends none either.
- No bridge method changes. JavaScript from an earlier release saves nothing, so native from this release never checks for it. Native from an earlier release ignores what this JavaScript saves.
