---
"hot-updater": minor
"@hot-updater/cli-tools": minor
---

Track local native modules the fingerprint missed.

A local Expo module from `create-expo-module --local` has no `package.json`, so the fingerprint recorded only its name, and a renamed function or an edited native body shipped as an OTA onto a binary without it. The fingerprint now follows these modules' native files and `expo-module.config.json`, the same inputs as a module with a `package.json`, on Expo apps and on bare apps with Expo modules installed.

Also tracked now:

- a local Expo module whose `package.json` has no `name`, or a different one, and a local Expo module named like its app;
- platform source paths in `react-native.config.js` with no `root`;
- a local React Native package that only Expo's autolinking finds, on a bare app with Expo modules installed;
- a `file:` folder dependency that pnpm, Yarn, or Bun copies into `node_modules`.

**Who sees a one-time fingerprint change:** only a project with one of these modules. Every other project, including stock Expo, bare, and Rock apps and local modules that have a `package.json`, keeps a byte-identical fingerprint. The engine stays `hot-updater/interface@1`.

**What to do:** if `doctor` or `deploy` reports a changed fingerprint naming the module's files, run `npx hot-updater fingerprint create`, rebuild, and release the app. Installed binaries on the old fingerprint stop receiving new updates until users have the new build.
