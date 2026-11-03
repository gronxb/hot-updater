---
"@hot-updater/react-native": minor
"@hot-updater/apple-helper": minor
"hot-updater": minor
---

A sandbox build's first screen is now a real screen: Home and Info tabs, dark mode, and the same screen over the running app with a shake. It sends the update server nothing when it opens, and `@hot-updater/react-native` gets no new API, no new bridge method, and no change to any source a normal build compiles.

- Home: the bundle the next launch runs, by bundle rather than by channel; a Dev server section; the previews this device opened; Scan QR; Enter a channel. iOS scans in the app. Android opens the system camera, and a pasted link gets the same checks.
- Over the app: Running, Reload, and what the next launch runs when it differs.
- A crash banner from what the launch left: a rollback only when one happened, and a verified bundle that crashed stays selected, with a reset.
- A sandbox app's `Info.plist` gets the camera and local network usage texts and `NSAllowsLocalNetworking`, keeping any value the app set.
