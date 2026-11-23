---
"@hot-updater/react-native": patch
---

fix: download an update right after the server signs its links, even when the user leaves the app

Storage download links are signed for an hour. Some updates failed with HTTP 403 `ExpiredRequest` because their requests went out long after signing:

- iOS: a download that started while the app was in the background went to the system's background URLSession. iOS always runs such a transfer at its own discretion, ignoring `isDiscretionary = false`; Apple documents that a discretionary transfer waits for conditions such as Wi-Fi and power, so it could go out hours later with the link fixed when it started. It now starts at once in the app's own session.
- iOS: an update now holds background time until it finishes, so the rest of its downloads go out right away when the user leaves the app mid-update. If iOS ends that time first, the update fails then as a cancelled network transfer, and the next check gets new links, instead of sending a request with an old link once the app runs again.
- iOS: a download that starts while the app is inactive, as when the user is leaving it, still uses the background session and keeps going after the app is suspended. The system's retries of such a transfer now stop after 30 minutes instead of seven days.
- Android: React Native's `fetch` resolves in a JavaScript timer, and Android runs none while the app is in the background, so an update response that arrived after the user left reached the app, and its links native, only once the user came back. The SDK's update requests on Android now use XMLHttpRequest, which answers from the network event. This part is JavaScript, so it also reaches apps on earlier native code through an OTA update.

No API change.
