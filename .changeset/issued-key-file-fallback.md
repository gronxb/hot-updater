---
"hot-updater": minor
---

An Apple or Google sign-in no longer refuses a read-only `secrets` adapter, such as the default `env()`. The CLI writes the key it issued to `<cacheDir>/issued/<name>.json`, readable by your user alone in a directory git ignores, and prints the file's path and the variables to store it in, never the key; the build that signed in signs and uploads with it from that file. Store the key, then delete the file: a later sign-in for the same name refuses to replace a key the file still holds. The checks before a sign-in run in order: an environment override, a key the adapter holds, a terminal outside CI, and somewhere for the key to go, the adapter or a writable `cacheDir`.
