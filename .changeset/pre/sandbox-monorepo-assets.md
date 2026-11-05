---
"@hot-updater/react-native": patch
---

The Android sandbox dev server loads an Expo app's assets, in a monorepo too.

- Metro lists every asset outside the project root, such as a hoisted dependency's, with `../` in `unstable_path`. The sandbox refused those assets with "The dev server listed an asset this build won't write". It now writes them.
- Expo URL-encodes `unstable_path` in the bundle, and React Native names each Android resource from that encoded path, while the asset list has the raw one. The sandbox wrote every Expo asset, fonts and images of the app itself included, under a name the app never asked for, so an app that waits for its fonts stayed blank. Each asset now goes under the name React Native reads.
- An asset name or type that could leave the session folder is still refused.
