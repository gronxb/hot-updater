import { bare } from "@hot-updater/bare";
import { mockDatabase, mockStorage } from "@hot-updater/mock";
import { defineConfig } from "hot-updater";

/**
 * examples/v0.88.0's iOS simulator scheme in the iOS CLI build job, which
 * copies a hot-updater.config.ts that re-exports it into the example. macOS
 * runners have no Docker for the proofs' Postgres and MinIO, and every
 * native build is tracked: the build is recorded in an in-memory database
 * and storage that live as long as the command.
 */
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
  storage: mockStorage({}),
  database: mockDatabase({ latency: { min: 0, max: 0 } }),
  plugins: [],
  updateStrategy: "appVersion",
});
