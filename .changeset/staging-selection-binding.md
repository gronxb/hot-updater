---
"@hot-updater/react-native": patch
---

Bind each bundle download to the Release it selected. Two downloads of the same bundle no longer swap the Release they record, and a failed download no longer leaves its Release for the next one. After `resetChannel`, an update found before the reset no longer downloads; check again. Requires rebuilding the native app.
