---
"@hot-updater/expo": minor
"hot-updater": minor
---

The minimum Expo SDK is now 55, in the `expo` peer range of `@hot-updater/expo` and in the docs.

- A project on an earlier SDK upgrades Expo first with `npx expo install expo@^55.0.0 --fix`, then runs `npx expo prebuild --clean` and releases a new native build.
- On an earlier SDK, `expo prebuild` with the config plugin and the Expo build adapter's bundle build stop with that command. Both read the `expo` the project installs.
- `hot-updater doctor` reports an Expo project below SDK 55 as an error, `EXPO_SDK_UNSUPPORTED`, from the installed `expo`, or from the declared range when Expo isn't installed.
