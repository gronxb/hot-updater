---
"hot-updater": patch
"@hot-updater/apple-helper": patch
---

An iOS scheme with `installPods: true` installs its pods before `native-build ios` computes the native build key, and the build uses them as installed. The key then holds the `Podfile.lock` the pods resolved to, and `Pods/Manifest.lock`, so a project whose `ios/` the build adapter's prebuild generates, such as an Expo app, can reuse a build instead of always building; pods that resolve differently still rebuild. A generated (git-ignored) `project.pbxproj` counts by its structure, with its objects labelled in the order they are reached from the root object, since `pod install` integrates a freshly generated project with new random object IDs each time; its files, groups, targets, build phases, settings, and their order still count. `@hot-updater/apple-helper` exports `installPodsIfNeeded`.
