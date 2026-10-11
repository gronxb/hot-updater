---
"hot-updater": patch
---

`deploy` no longer guesses the target app version of a project that builds several apps: when Xcode app targets or Android product flavors declare different versions, it asks for `-t` and lists them, and `app-version` shows them. `build:ios`, `build:android`, and their `run:` commands read the version of the app target or flavor their scheme builds.
