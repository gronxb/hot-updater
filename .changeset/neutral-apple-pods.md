---
"hot-updater": patch
"@hot-updater/apple-helper": patch
"@hot-updater/plugin-core": minor
"@hot-updater/react-native": patch
"@hot-updater/bare": patch
"@hot-updater/rock": patch
"@hot-updater/expo": patch
---

Resolve CocoaPods environment policy through the selected build integration.
Keep React Native prebuilt defaults and explicit environment overrides in the
React Native integration, and remove the common CLI's transitive React Native
dependency through the Apple build helper. Projects using other runtimes can
install pods without React Native discovery or injected RN settings.
