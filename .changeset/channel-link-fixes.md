---
"@hot-updater/react-native": patch
---

A device switched to a channel that holds nothing for its build any more, as after `hot-updater channel delete`, leaves the switch. The server answers the deleted channel's scope with an empty catalog; a check without `channel` then returns a forced rollback to the built-in bundle whose `updateBundle()` also clears the runtime channel, as `resetChannel()` does, so the next check reads the build's default channel. Native builds of this version reset through a new `resetChannelIfSelectionCurrent` method, which checks the catalog and resets in one step, so a newer catalog accepted meanwhile, such as by a native `HotUpdaterInstance` check, keeps the channel. JavaScript checks for the method and, on native builds of earlier 1.x versions, checks the catalog and then calls `resetChannel`, so the fix also ships over the air. The native `HotUpdaterInstance` checks on iOS and Android follow the same rule.
