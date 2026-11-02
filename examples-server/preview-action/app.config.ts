import { bare } from "@hot-updater/bare";
import { defineConfig, secret } from "hot-updater";

import { database, storage } from "./shared.ts";

/**
 * examples/v0.85.0's config in the preview action's CI proof, which copies a
 * hot-updater.config.ts that re-exports it into the example: the build,
 * schemes, and fingerprint inputs of the example's own config, on the
 * proof's backend, with the bundle signed by a local key the seed generates
 * and the keystore read from the job's environment, as the config sets no
 * `secrets` adapter.
 */
export default defineConfig({
  nativeBuild: {
    android: {
      releaseApk: {
        packageName: "com.hotupdaterexample",
        aab: false,
        signing: { keystore: secret("android-keystore") },
      },
    },
    ios: {
      simulator: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        installPods: true,
        simulator: true,
      },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [],
  fingerprint: {
    debug: true,
    extraSources: {
      ios: [
        "ios/HotUpdaterExampleBrownfield/**/*.swift",
        "ios/HotUpdaterExample.xcodeproj/project.pbxproj",
      ],
      android: [
        "android/brownfieldlib/src/**/*.kt",
        "android/brownfieldlib/build.gradle.kts",
      ],
    },
  },
  updateStrategy: "fingerprint",
  signing: secret("bundle-signing-key"),
});
