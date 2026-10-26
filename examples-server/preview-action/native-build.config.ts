import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

import { database, storage } from "./shared.ts";

/**
 * examples/v0.85.0's config in the native build action's CI proof, which
 * copies a hot-updater.config.ts that re-exports it into the example: an
 * Android release scheme whose keystore the job's environment holds, one
 * whose keystore it lacks, and an iOS release scheme that signs with an App
 * Store Connect API key, on the proof's backend. It sets no `secrets`
 * adapter: every credential comes from the job's environment, or from the
 * local() store `secrets put` writes under HOT_UPDATER_HOME.
 */
export default defineConfig({
  nativeBuild: {
    android: {
      release: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: "secret:release-keystore" },
      },
      widget: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: "secret:widget-keystore" },
      },
    },
    ios: {
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        signing: { ascApiKey: "secret:asc-api-key" },
      },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [],
  updateStrategy: "fingerprint",
});
