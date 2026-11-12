---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
"@hot-updater/console": patch
---

A sandbox build's built-in bundle is no longer a patch base. `findNativeBuild(scope, { builtInOlderThan })` answers null for a sandbox scope without a read, so a deploy to a `sandbox-*` channel makes no patch from a sandbox build, and the CLI also passes over a sandbox build that an older server answers. `updateBundle` refuses a new patch from a sandbox build's built-in bundle with a 400 (one read of each new patch's base), so `hot-updater patch --base-artifact-id` refuses one in a single line and deletes the patch file it uploaded. Patches already stored stay.

The Console names no patch base on a sandbox build's page and reads none: its Built-in bundle card says deploys make no patches from it, the Patches card's empty state says the same, and a release on a sandbox channel shows no native build. A sandbox IPA gets no TestFlight advice: no `hot-updater testflight` command, no TestFlight clause under its QR code, and an App Store export says only that it doesn't install from the page. A sandbox build already on TestFlight keeps its store state.
