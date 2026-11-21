---
"@hot-updater/react-native": patch
---

fix(react-native): on Android, a download that another update check made stale keeps its files for the next install of the same bundle.

- When a newer check replaces the selection while a bundle downloads, as the sandbox's **Open latest** does while the app's own launch check downloads the same bundle, Android now refuses the install before it moves the files into place. The verified files stay staged, and the next install of that bundle reuses them instead of downloading everything again. Before, Android moved them into place, then deleted them, so the second install downloaded every file again and failed if a file request failed. iOS already worked this way.
