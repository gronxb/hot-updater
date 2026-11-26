---
"@hot-updater/react-native": patch
---

Update requests no longer fail with "Request timed out" when the app comes back from the background. The request timeout counts only the time the app runs in the foreground, so a timer that came due while iOS had suspended the app no longer aborts a response that arrived meanwhile. On iOS, the update check and `updateBundle()` also hold background time until the server answers and the download finishes, so a request sent as the user leaves the app still starts its download before the links expire. JavaScript checks for the new native methods and falls back to the timeout fix alone on native code from an earlier release.
