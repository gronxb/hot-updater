---
"hot-updater": patch
---

`hot-updater channel set <channel>` in an Expo CNG project points at the `@hot-updater/expo` plugin's `channel` option as where the build takes its channel from. For a dynamic `app.config.*` it shows that option read from an environment variable, as the pull request preview guide does (`channel: process.env.PREVIEW_CHANNEL ?? "production"`), and the variable to build with (`PREVIEW_CHANNEL=<channel>`), instead of a channel to hardcode. For a static `app.json` it shows the option set to the channel, as JSON.
