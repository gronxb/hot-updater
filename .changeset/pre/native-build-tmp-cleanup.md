---
"hot-updater": patch
"@hot-updater/apple-helper": patch
---

`hot-updater native-build ios` removes the temporary directories it builds in, which it used to leave in the system's temporary directory, 10 GB or more each.

- The Xcode DerivedData of a simulator build, which can take 10 GB or more, is removed once the `.app` is copied out of it, whether the build succeeds or fails.
- The `.xcarchive` and the export are written straight to the build directory, instead of temporary directories copied into it.
- The build directory is removed once its artifact is copied to the output path, and a failed build removes it, and every other directory it used, right away.
- A build interrupted with Ctrl+C, or ended by a signal, removes them too.
- The build log in `.hot-updater/log` stays where it is, after a failed build too.
