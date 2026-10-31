import { bare } from "@hot-updater/bare";
import { defineConfig, secret } from "hot-updater";

import { database, storage } from "./shared.ts";

/**
 * examples/v0.85.0's config in the release action's CI proof, which copies a
 * hot-updater.config.ts that re-exports it into the example: an Android store
 * scheme whose keystore and Play service account the job's environment holds,
 * on the proof's backend. The fingerprint hashes the native interface, so the
 * library module's build file is declared, as a project declares what it wants
 * to ship through the store: the proof's native change edits it.
 */
export default defineConfig({
  nativeBuild: {
    android: {
      release: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: secret("release-keystore") },
      },
    },
    ios: {
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
      },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [],
  fingerprint: {
    extraSources: {
      android: ["android/brownfieldlib/build.gradle.kts"],
    },
  },
  updateStrategy: "fingerprint",
});
