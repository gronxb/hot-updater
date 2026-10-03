import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

import { runtimeLaunchArguments } from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { scenarioEngine } from "./engine.ts";
import { createHotUpdaterReporter } from "./report.ts";

const context = readMobileContext();

export default {
  projectId: "hot-updater-ota",
  tests: ["e2e/mobile/scenarios.e2e.ts"],
  workers: 1,
  retries: 0,
  timeout: context.setupTimeoutMs + context.scenarioTimeoutMs + 1_000,
  cleanupTimeout: context.cleanupTimeoutMs,
  launchTimeout: 120_000,
  actionTimeout: 120_000,
  assertionTimeout: 30_000,
  cache: "off",
  trace: "off",
  video: "off",
  // The wrapper overrides this with a unique directory inside the checkout;
  // context.resultsDir may be an external bot artifact directory.
  output: "e2e/results/mobile/sdk",
  reporters: ["list", createHotUpdaterReporter(context)],
  targets: [
    {
      name: context.platform,
      engine: scenarioEngine(
        mobile({
          platform: context.platform,
          device: context.deviceId,
          session: context.session,
          snapshot: "full",
        }),
      ),
      // appPath suppresses the mobile pool's bundleId-only warm launch. The
      // harness installs explicitly before preparing the first scenario.
      app: {
        bundleId: context.appId,
        appPath: context.appPath,
        launchArguments: runtimeLaunchArguments(context.platform),
      },
    },
  ],
} satisfies E2EConfig;
