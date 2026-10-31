import { bare } from "@hot-updater/bare";
import { defineConfig, secret } from "hot-updater";

import { database, storage } from "./shared.ts";

/**
 * examples/v0.85.0's config in the preview action's store proof: a sandbox .aab
 * scheme whose keystore and Play service account the job's environment holds,
 * and a normal scheme the store path must refuse.
 */
export default defineConfig({
  nativeBuild: {
    android: {
      release: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: secret("release-keystore") },
      },
      sandboxStore: {
        packageName: "com.hotupdaterexample",
        signing: { keystore: secret("release-keystore") },
        sandbox: true,
      },
    },
    ios: {},
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [],
  updateStrategy: "fingerprint",
});
