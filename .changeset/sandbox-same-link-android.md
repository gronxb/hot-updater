---
"@hot-updater/react-native": patch
---

fix(react-native): on Android, opening the same sandbox link again asks for it again.

A pull request's QR code stays the same across pushes, so after a JavaScript-only push a tester scans it again to get the new bundle. On Android that did nothing while the app's task was alive: Android remembers the intent that started a task, and when the identical link came again it only brought the task forward, so the sandbox never saw it.

- When a link starts the app's task, the sandbox moves to a new task that the launcher's intent starts, and carries the link along. Opening the same link again then reaches the sandbox, which asks "Open latest on <channel>?", whether the app runs a channel's bundle or the built-in one, or the sandbox screen is in front.
- Tapping the app's icon while a link-started app runs now shows the app, as it does for an app the icon started. It used to show the sandbox screen over the app.
- Opening the app from the screen after Android ended its process now brings back the app's activity that was already in the task. With the `standard` and `singleTop` launch modes, it used to start a second one on top.

Only sandbox builds change. There is no JavaScript change and no JS↔native change.
