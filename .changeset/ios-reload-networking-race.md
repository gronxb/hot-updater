---
"@hot-updater/react-native": patch
---

Stop a request made just before an iOS reload from crashing the app. React Native's networking could rebuild its handlers while the old runtime was being torn down, find no `BlobModule`, and abort with an uncaught `NSInvalidArgumentException`. During a staged launch that crash rolled back a healthy bundle and added it to crash history, so it could not be installed again. Reload now holds the networking queues until the next runtime has registered its modules.
