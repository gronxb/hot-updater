---
"@hot-updater/react-native": minor
---

Add a `fetch` option to `HotUpdater.init` so an instance's JavaScript requests (release catalogs, artifact lookups, and client plugins such as `insights()`) can use a fetch other than the global one, such as `react-native-nitro-fetch`. It defaults to the global `fetch`; native downloads and the native recovery check don't use it.
