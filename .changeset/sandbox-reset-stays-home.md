---
"@hot-updater/react-native": patch
---

The sandbox's **Reset to built-in bundle**, on the Info tab and on a crash banner, no longer runs the built-in bundle right away. The screen stays on Home, whose row reads **Open built-in bundle** and runs it when tapped, also over a running app that still runs another bundle. Normal builds are unchanged.
