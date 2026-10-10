import { mobile } from "@e2e-dev/mobile";
import type { E2EConfig } from "e2e";

import { runtimeLaunchArguments } from "./attempt.ts";
import { readMobileContext } from "./context.ts";
import { createHotUpdaterReporter } from "./report.ts";

const context = readMobileContext();

export default {
  projectId: "hot-updater-ota",
  tests: ["e2e/mobile/scenarios.e2e.ts"],
  workers: 1,
  retries: 0,
  timeout: context.testTimeoutMs,
  cleanupTimeout: context.cleanupTimeoutMs,
  launchTimeout: 120_000,
  actionTimeout: 120_000,
  assertionTimeout: 30_000,
  // No agent steps run, so the replay cache has nothing to record.
  cache: "off",
  trace: "off",
  video: "off",
  // The wrapper overrides this with a unique directory inside the checkout;
  // context.resultsDir may be an external bot artifact directory.
  output: "e2e/results/mobile/sdk",
  // markdown writes summary.md and a page per failed scenario beside report.json.
  reporters: ["list", "markdown", createHotUpdaterReporter(context)],
  targets: [
    {
      name: context.platform,
      engine: mobile({
        platform: context.platform,
        device: context.deviceId,
        session: context.session,
        snapshot: "full",
      }),
      // appPath suppresses the mobile pool's bundleId-only warm launch. The
      // suite installs it explicitly before preparing the first scenario.
      // launchArguments ride every relaunch of the pinned app.
      app: {
        bundleId: context.appId,
        appPath: context.appPath,
        launchArguments:
          context.runtime === "lynx"
            ? [] // The Lynx driver supplies a fresh native launch generation per launch.
            : runtimeLaunchArguments(context.platform),
      },
    },
  ],
} satisfies E2EConfig;
