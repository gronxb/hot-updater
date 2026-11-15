---
"@hot-updater/android-helper": patch
"@hot-updater/react-native": patch
---

fix(android-helper): Windows Expo builds keep CMake object paths within MAX_PATH, and the sandbox names the bundle as its Downloaded list does.

- Expo's root project plugin gives every Android module `-DCMAKE_OBJECT_PATH_MAX` from the `expo.android.cmakeObjectPathMax` Gradle property, 1024 by default, so the Windows init script's own value never applied to an Expo app. On Windows the init script now sets that property to 259, unless gradle.properties, `-P` or the environment set it; a value set there stands, and `0`, which turns Expo's limit off, leaves every module without one. Other apps still get `-DCMAKE_OBJECT_PATH_MAX=259` on each module whose own CMake arguments don't set it.
- The limit is 259 instead of 250: at 250, a 179-character object directory left no room for CMake's hash and a 40-character file name.
- A Gradle build's log names the command as it ran, with the Windows init script.
- The sandbox's "Couldn't open" dialog names the selected bundle by the ID its Downloaded list shows, the release ID `HotUpdater.getBundleId()` returns, on iOS and Android.
