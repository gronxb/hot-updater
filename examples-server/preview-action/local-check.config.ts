// Untracked: the local real check's config (deleted after the check).
import { bare } from "@hot-updater/bare";
import { defineConfig } from "hot-updater";

import { database, storage } from "./shared.ts";

export default defineConfig({
  nativeBuild: {
    ios: {
      releaseSimulator: {
        bundleIdentifier: "org.reactjs.native.example.HotUpdaterExample",
        scheme: "HotUpdaterExample",
        configuration: "Release",
        simulator: true,
        installPods: true,
      },
    },
  },
  build: bare({ enableHermes: true, resetCache: false }),
  storage,
  database,
  plugins: [],
  updateStrategy: "appVersion",
});
