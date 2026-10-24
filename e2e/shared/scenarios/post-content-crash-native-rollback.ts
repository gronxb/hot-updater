import { crashAfterFirstContent } from "./post-content-crash-native-recovery.ts";
import type { ScenarioDefinition } from "./types.ts";

export const postContentCrashNativeRollbackScenario: ScenarioDefinition = {
  name: "post-content-crash-native-rollback",
  run: async (app) => {
    await crashAfterFirstContent(app, {
      crash: "post-content-rollback-crash-detox",
      stable: "post-content-rollback-stable-detox",
    });
    // A rollback is always forced, so a working startup check would reload
    // into it at once; the crash bundle's own check fails instead.
    await app.control(
      "disable post-content crash Release",
      "/e2e/jobs/patch-release",
      {
        enabled: false,
        releaseId: "$postCrashReleaseId",
      },
    );
    await app.launch("relaunch post-content crash bundle after disabling it", {
      expectCrash: true,
    });
    await app.control(
      "wait native check stages rollback to previous bundle",
      "/e2e/jobs/wait-for-metadata",
      {
        attempts: 240,
        bundleId: "$postCrashStableBundleId",
        releaseId: "$postCrashStableReleaseId",
        verificationPending: true,
      },
    );
    // The rollback waits for the next launch: the crash bundle still runs
    // until its fatal.
    await app.control(
      "wait post-content crash exit after staging rollback",
      "/e2e/jobs/wait-for-app-exit",
      { bundleId: "$postCrashBundleId" },
    );
    await app.launch("open the app with the staged rollback");
    await app.control(
      "verify rolled-back bundle first content",
      "/e2e/jobs/wait-for-metadata",
      {
        bundleId: "$postCrashStableBundleId",
        releaseId: "$postCrashStableReleaseId",
        verificationPending: false,
      },
    );
    await app.control(
      "assert rollback to previous bundle applied",
      "/e2e/assert-launch-report",
      {
        status: "UPDATE_APPLIED",
        fromBundleId: "$postCrashBundleId",
        fromReleaseId: "$postCrashReleaseId",
        toBundleId: "$postCrashStableBundleId",
        toReleaseId: "$postCrashStableReleaseId",
      },
    );
    await app.assertText(
      "rolled-back Bundle runs",
      "runtime-bundle-id",
      "$postCrashStableBundleId",
    );
    await app.assertText(
      "rolled-back Release runs",
      "runtime-release-state",
      "$postCrashStableReleaseId",
    );
    await app.assertText(
      "rolled-back marker runs",
      "runtime-scenario-marker",
      "post-content-rollback-stable-detox",
    );
    await app.control(
      "assert rolled-back bundle active",
      "/e2e/assert-metadata-active",
      { bundleId: "$postCrashStableBundleId" },
    );
  },
};
