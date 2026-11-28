---
"@hot-updater/console": patch
---

Bundles and Native builds now open on the `production` channel, as Insights does, instead of mixing every channel. Bundles opens on production's iOS bundles, because the bundle list filters by a channel and a platform together. A project without a `production` channel still opens on all channels. "All channels" stays in the channel filter, and choosing it adds `channels=all` to the URL, so a link or a refresh keeps it. Links that name a channel, bundle, scope, or release land where they did, and a link to one release still shows every channel's list. The page reads the channel list it already loaded before it reads bundles or builds, so it never reads every channel on the way to production.
