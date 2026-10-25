import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";
import { vault } from "hot-updater/plugins";

import { database, storage } from "./shared.ts";

/**
 * examples/v0.85.0's config in the native build action's CI proof, which
 * copies a hot-updater.config.ts that re-exports it into the example: an
 * Android release scheme whose keystore the vault keeps, one whose keystore
 * it lacks, and an iOS release scheme that signs with the vault's App Store
 * Connect API key, on the proof's backend.
 */
export default defineConfig({
  nativeBuild: {
    android: {
      release: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: "vault:release-keystore" },
      },
      widget: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: "vault:widget-keystore" },
      },
    },
    ios: {
      release: {
        bundleIdentifier: "com.hotupdaterexample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        signing: { ascApiKey: "vault:asc-api-key" },
      },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [vault()],
  updateStrategy: "fingerprint",
});
