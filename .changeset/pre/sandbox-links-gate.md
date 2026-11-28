---
"hot-updater": minor
"@hot-updater/protocol": minor
"@hot-updater/android-helper": minor
"@hot-updater/react-native": minor
---

Sandbox builds now show a native screen before the app's JavaScript starts, and open preview links natively. `@hot-updater/react-native` gets no new API, no new bridge method, and no change to any source a normal build compiles. See the Sandbox builds guide.

- iOS: a gate at the deepest `RCTRootViewFactory` method holds React Native behind a stable container until the screen's Open. Notifications, background entry points, shortcuts and the app's own links start the app at once; a host it can't gate starts as usual, with a log.
- Android: the build reads the variant's merged manifest and moves the launcher entry to the sandbox's activity, which forwards anything addressed to the app with its intent. It refuses more than one launcher and task settings its activity can't share a task with.
- A link is checked against the build's fingerprint, confirmed by name, checked on the server, and only then deletes downloaded bundles. A failure afterwards shows what's selected now and offers a retry. A link waits across restarts for the app's first answered update check.
- `createPreviewLink` and `parsePreviewLink` join `@hot-updater/protocol/native-artifact`, and an artifact check refuses a sandbox build whose launcher or URL scheme isn't the sandbox's.
