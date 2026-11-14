---
"@hot-updater/react-native": patch
---

fix(react-native): a sandbox link whose first check didn't answer now recovers the way the screen says.

When a fresh sandbox build gets a link, it starts the app under the screen so the app's own update check can find the server. If that one check fails, for example because the first request took longer than its timeout on a slow device, the screen says after a minute to open the app. Until now, opening it showed the app that had already checked, so nothing checked again until the process was stopped by hand.

- **Open** on that screen now starts the app anew (a reload on iOS, a restart on Android), so its launch check runs again, and the link asks over the app once the server answers. While the first check still has time, Open only shows the app, as before.
- **Reload** over the app now works while a link waits for a server. It used to do nothing.
- Android asks the waiting link in the restarted process. Other launches that skip the screen, such as a notification, still leave the link to the next screen.
- The screen says "Checking <channel>…" from its first frame for a link it will start the app for. It no longer shows the open-the-app message for a moment first.

Only sandbox builds change. No JavaScript or JS↔native change.
