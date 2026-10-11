---
"@hot-updater/protocol": patch
"@hot-updater/react-native": patch
"@hot-updater/console": patch
---

A forced bundle stays required for devices that skip it. When a device updates past a forced bundle its cohort was eligible for, straight to a newer bundle that is not forced, the update check now returns `shouldForceUpdate: true`, so `wrap` reloads into the newer bundle right away. Devices that already run the forced bundle get later updates as they were deployed. A device that staged a newer bundle before an older one was marked forced reloads into the staged bundle on its next check. A device on the built-in bundle, or one switching channels explicitly, counts every forced bundle in the channel published after its binary.
