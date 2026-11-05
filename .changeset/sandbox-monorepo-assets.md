---
"@hot-updater/react-native": patch
---

The Android sandbox dev server loads an app in a monorepo.

- Metro lists every asset outside the project root, such as a hoisted dependency's, with `../` in `unstable_path`. The sandbox refused those assets with "The dev server listed an asset this build won't write". It now writes each one under the resource name React Native reads.
- An asset name or type that could leave the session folder is still refused.
