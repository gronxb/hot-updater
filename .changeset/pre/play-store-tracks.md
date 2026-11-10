---
"hot-updater": minor
"@hot-updater/server": minor
"@hot-updater/android-helper": minor
"@hot-updater/plugin-core": minor
"@hot-updater/console": patch
"@hot-updater/test-utils": patch
---

Select Google Play closed, open, or production tracks, optionally use staged rollout, and promote builds with a recorded Play submission without uploading them again. Keep sandbox submissions on internal testing.

Keep release-action OTA updates working after promotion and allow reruns with an explicit `--rollout` to update or complete public-track rollouts. Skip implicit reruns and downward promotions, and preserve release metadata when updating a rollout.

Upgrade a self-hosted server and Console before the CLI: older RC servers reject the new destinations with HTTP 400 after Play has released the build, and older RC Consoles crash on the new `submitted_to` labels.
