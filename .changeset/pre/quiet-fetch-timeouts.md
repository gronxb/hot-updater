---
"@hot-updater/react-native": patch
"@hot-updater/protocol": patch
---

Report a request that the SDK's timeout cuts off as `Request timed out` under Expo's fetch too, which rejects it with `fetch failed: FetchRequestCanceledException` instead of an `AbortError`: update failures now classify it as a network timeout, so an update check that times out is no longer reported as an unknown failure, and the same holds for client plugin requests. Expo's other fetch failures without a response classify as network errors.
