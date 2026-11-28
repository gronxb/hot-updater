---
"hot-updater": patch
"@hot-updater/console": patch
---

Stop telling a sandbox APK's installer to build with `sandbox: true`, and give `native-build mark`'s sandbox refusal a next step.

- The Console's Install card for a sandbox `.apk` says its `.sandbox` ID installs it beside a Play copy, instead of the signing-key advice that ends in "build with sandbox: true". A normal APK's card is unchanged.
- `native-build mark` on a sandbox build now says to mark a build of a scheme without `sandbox: true`, and prints `npx hot-updater native-build find -p <platform> -s <scheme>` on its own line to find one. `--json` still reports `reason: "sandbox_build"`.
