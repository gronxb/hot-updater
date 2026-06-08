import type { DetoxScenarioDefinition } from "./types.ts";

export const targetCohortsOnlyScenario: DetoxScenarioDefinition = {
  name: "target-cohorts-only",
  run: async (app) => {
    await app.control(
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
    await app.launch("launch target cohort app");
    await app.typeText("enter qa cohort", "cohort-input", "qa");
    await app.tap("apply qa cohort", "action-apply-cohort-input");
    await app.assertText(
      "assert qa cohort applied",
      "cohort-action-result",
      "set -> qa",
    );
    await app.tap(
      "install target cohort update",
      "action-install-current-channel-update",
    );
    await app.control(
      "wait target cohort metadata pending",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        relaunchLimit: 0,
        verificationPending: true,
      },
    );
    await app.assertText(
      "assert target cohort action result",
      "update-action-result",
      "current-channel -> installed $bundleId (UPDATE)",
    );
    await app.reload("reload target cohort update");
    await app.control(
      "wait target cohort metadata stable",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$bundleId",
        verificationPending: false,
      },
    );
    await app.assertText(
      "assert target cohort launch",
      "launch-status-result",
      "Current Launch Status: STABLE",
    );
  },
};
