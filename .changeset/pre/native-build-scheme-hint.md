---
"hot-updater": patch
---

When no native build scheme is configured, the experimental native build commands (`build:android`, `build:ios`, `run:android`, and `run:ios`, available with `EXPERIMENTAL` set) say to add one under `nativeBuild.<platform>` in `hot-updater.config.ts` instead of linking to the Native Build docs page, which is removed until native builds are ready.
