---
"@hot-updater/react-native": patch
---

fix(ios, android): the launch status no longer rarely reports `UNCHANGED` for a launch that applied an update. When JavaScript read the status at the moment first content verified the new bundle, it could see the bundle verified but no launch report yet, and answer a final `UNCHANGED` instead of `UPDATE_APPLIED` (Insights then recorded the launch as unchanged). The read now waits for the verification to finish writing. Takes effect with the next native build.
