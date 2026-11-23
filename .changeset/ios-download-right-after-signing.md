---
"@hot-updater/react-native": patch
---

fix(ios): download an update right after the server signs its links, even when the user leaves the app

Storage download links are signed for an hour. A small share of iOS updates failed with HTTP 403 `ExpiredRequest` because their requests went out hours after signing:

- A download that started while the app was in the background went to the system's background URLSession. iOS always runs such a transfer at its own discretion, ignoring `isDiscretionary = false`, so it could wait hours (on a device, typically for Wi-Fi and power) with the link fixed when it started. It now starts at once in the app's own session.
- An update now holds background time until it finishes, so the rest of its downloads go out right away when the user leaves the app mid-update. If iOS ends that time first, the update fails then as a cancelled network transfer, and the next check gets new links, instead of sending a request with an old link once the app runs again.
- A download that starts while the app is inactive, as when the user is leaving it, still uses the background session and keeps going after the app is suspended. The system's retries of such a transfer now stop after 30 minutes instead of seven days.

No API or JavaScript change.
