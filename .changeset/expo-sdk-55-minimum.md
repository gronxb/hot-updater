---
"@hot-updater/expo": minor
"hot-updater": minor
---

The minimum Expo SDK is now 55, in the `expo` peer range of `@hot-updater/expo` and in the docs.

- A project on an earlier SDK upgrades Expo first with `npx expo install expo@^55.0.0 --fix`, then runs `npx expo prebuild --clean` and releases a new native build.
- `hot-updater doctor` reports an Expo project below SDK 55 as an error, `EXPO_SDK_UNSUPPORTED`. `init` and `deploy` don't refuse one.
