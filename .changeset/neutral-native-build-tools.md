---
"@hot-updater/apple-helper": patch
"@hot-updater/android-helper": patch
"hot-updater": patch
"@hot-updater/plugin-core": minor
"@hot-updater/react-native": patch
"@hot-updater/bare": patch
"@hot-updater/rock": patch
"@hot-updater/expo": patch
---

Select Xcode application products before dependency frameworks without excluding
React Native target names. Keep native build progress tied to Xcode and Gradle
tasks, and remove the unused React Native development-port argument path.
The selected integration now supplies the default development server port.
Bare, Rock and Expo retain the React Native default, explicit CLI ports take
precedence, and integrations without a default do not create an ADB reverse rule.
