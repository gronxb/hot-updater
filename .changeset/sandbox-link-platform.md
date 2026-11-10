---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
---

A preview link names the platform it's for: `createPreviewLink({ platform })` adds `&platform=ios` or `&platform=android`, `parsePreviewLink` returns it, and reads any other value as none. The preview action's links and QR codes name theirs. Both platforms' sandbox builds of an app often register the same URL scheme, so an iPhone's camera opened the Android QR code in the iOS sandbox build, which said only that the channel "needs another build". Now a sandbox build refuses the other platform's link before anything else, with "This QR is for Android" and "Scan the iPhone QR code for pr-12." on iOS, and "This QR is for iOS" and "Scan the Android QR code for pr-12." on Android. A link without `platform` reads as before, and a sandbox build from before this version ignores the parameter.
