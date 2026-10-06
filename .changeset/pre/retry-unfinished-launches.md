---
"@hot-updater/react-native": patch
---

Give a bundle one retry after a launch that ends before the first render without a crash, such as a user leaving during the splash screen. The next start still rolls back and reports `RECOVERED`, but the bundle no longer goes into crash history at once: the session that recovered does not install it again, and a later session retries it. A second unfinished launch, or a crash, adds it to crash history as before. Requires rebuilding the native app.
