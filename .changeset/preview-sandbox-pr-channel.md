---
"hot-updater": patch
---

The preview action fails a native build it makes that embeds another channel than the pull request's, a new sandbox build or store build too, before it deploys, with the fix for an Expo project: set the channel in the `@hot-updater/expo` config plugin, such as from a `PREVIEW_CHANNEL` variable the job sets to `pr-<n>`. A sandbox build an Expo config plugin pinned to `production` no longer registers there unnoticed. A sandbox build another pull request made is still reused, whichever channel it embeds, and the build log names the pull request's channel.
