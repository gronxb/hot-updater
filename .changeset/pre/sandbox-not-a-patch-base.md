---
"@hot-updater/server": patch
"@hot-updater/plugin-core": patch
"hot-updater": patch
"@hot-updater/console": patch
---

A sandbox build's built-in bundle is no longer a patch base. `findNativeBuild(scope, { builtInOlderThan })` answers null for a sandbox scope without a read, so a deploy to a `sandbox-*` channel makes no patch from a sandbox build, and the CLI also passes over a sandbox build that an older server answers. Core refuses a new patch from a sandbox build's built-in bundle, in `updateBundle` and in a deploy's new bundles, with a 400 (one read of each new patch's base; a deploy without patches reads nothing more). Patches already stored stay.

`hot-updater patch --base-artifact-id` refuses a sandbox build's built-in bundle in one line before it makes the patch, on any server: it pages the builds of the `sandbox-*` channels, where only sandbox builds register. When core refuses a patch, the CLI deletes the patch file it uploaded; any other failure, such as a lost answer after the server stored the patch, keeps the file.

The Console names no patch base on a sandbox build's page and reads none: its Built-in bundle card says deploys make no patches from it, the Patches card's empty state says the same, and a release on a sandbox channel shows no native build. The Console no longer shows the `npx hot-updater testflight` command on any IPA. A sandbox IPA also gets no TestFlight clause under its QR code, and its App Store export says only that it doesn't install from the page. A build already on TestFlight keeps its store state.
