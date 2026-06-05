import type { DetoxScenarioDefinition } from "./types.ts";

export const targetCohortsOnlyScenario: DetoxScenarioDefinition = {
  name: "target-cohorts-only",
  run: async (scenario) => {
    await scenario.control(
      "deploy target cohort bundle",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "target-cohorts-only-detox",
        mode: "reset",
        rollout: 0,
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
        targetCohorts: ["qa"],
      },
      {
        saveResultAs: "bundleId",
      },
    );
    await scenario.typeText("enter qa cohort", "cohort-input", "qa");
    await scenario.tap("apply qa cohort", "action-apply-cohort-input");
    await scenario.assertText(
      "assert qa cohort applied",
      "cohort-action-result",
      "set -> qa",
    );
    await scenario.tap(
      "install target cohort update",
      "action-install-current-channel-update",
    );
    await scenario.control(
      "wait target cohort metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await scenario.reload("reload target cohort update");
    await scenario.control(
      "wait target cohort metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await scenario.assertText(
      "assert target cohort launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
  },
};
