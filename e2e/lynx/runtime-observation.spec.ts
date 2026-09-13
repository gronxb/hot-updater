import type { CheckForUpdateResult, LaunchInfo } from "@hot-updater/lynx";
import { describe, expect, it, vi } from "vitest";

import {
  applyForcedUpdate,
  confirmRuntimeReady,
  installCheckedUpdate,
  readRuntimeSnapshot,
} from "../../examples/lynx/src/e2eApp/runtimeObservation";

const launch: LaunchInfo = {
  platform: "ios",
  runtimeId: "runtime-1",
  running: {
    kind: "BUNDLE",
    bundleId: "bundle-A",
    releaseId: "release-A",
    channel: "production",
  },
  confirmed: true,
  next: {
    kind: "BUNDLE",
    bundleId: "bundle-B",
    releaseId: "release-B",
    channel: "production",
  },
};

const update = (
  overrides: Partial<CheckForUpdateResult> = {},
): CheckForUpdateResult => ({
  id: "release-B",
  bundleId: "bundle-B",
  releaseId: "release-B",
  message: null,
  rolloutCohortCount: 1,
  shouldForceUpdate: false,
  status: "UPDATE",
  targetCohorts: ["1"],
  transitionKind: "INSTALL",
  fileUrl: "https://updates.example/B.zip",
  fileHash: "hash-B",
  updateBundle: vi.fn().mockResolvedValue(true),
  ...overrides,
});

function runtimeClient() {
  return {
    getLaunchInfo: vi.fn().mockResolvedValue(launch),
    getActiveUpdateState: vi.fn().mockReturnValue({
      activeSelection: launch.next,
      stableSelection: launch.running,
      verificationPending: false,
    }),
    getChannel: vi.fn().mockReturnValue("production"),
    getDefaultChannel: vi.fn().mockReturnValue("production"),
    isChannelSwitched: vi.fn().mockReturnValue(false),
    getCohort: vi.fn().mockReturnValue("qa"),
    getCrashHistory: vi.fn().mockReturnValue(["crashed-B", "crashed-C"]),
  };
}

describe("Lynx E2E runtime observations", () => {
  it("sends one readiness signal and publishes only its native result", async () => {
    const notifyAppReady = vi
      .fn()
      .mockResolvedValue({ status: "UPDATE_APPLIED" });
    const publish = vi.fn().mockResolvedValue(undefined);

    await expect(
      confirmRuntimeReady({ notifyAppReady }, publish),
    ).resolves.toEqual({ status: "UPDATE_APPLIED" });
    expect(notifyAppReady).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      "Current Launch Status: UPDATE_APPLIED",
    );
  });

  it("does not retry or publish readiness after native rejection", async () => {
    const notifyAppReady = vi
      .fn()
      .mockRejectedValue(new Error("content not observed"));
    const publish = vi.fn();

    await expect(
      confirmRuntimeReady({ notifyAppReady }, publish),
    ).rejects.toThrow("content not observed");
    expect(notifyAppReady).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps running identities distinct from a staged update", async () => {
    const client = runtimeClient();
    expect(await readRuntimeSnapshot(client)).toMatchObject({
      currentBundleId: "bundle-A",
      currentReleaseId: "release-A",
      stagingBundleId: "bundle-B",
      stagingReleaseId: "release-B",
      currentCohort: "qa",
      crashHistoryCount: "2",
      verificationPending: true,
    });
    expect(client.getLaunchInfo.mock.invocationCallOrder[0]).toBeLessThan(
      client.getCrashHistory.mock.invocationCallOrder[0],
    );
  });

  it("reports readiness from the running generation and staged state from next", async () => {
    const client = runtimeClient();
    client.getLaunchInfo.mockResolvedValue({
      ...launch,
      confirmed: false,
      next: null,
    });
    expect(await readRuntimeSnapshot(client)).toMatchObject({
      currentBundleId: "bundle-A",
      stagingBundleId: null,
      verificationPending: true,
    });

    client.getLaunchInfo.mockResolvedValue({
      ...launch,
      next: launch.running,
    });
    expect(await readRuntimeSnapshot(client)).toMatchObject({
      currentBundleId: "bundle-A",
      stagingBundleId: "bundle-A",
      verificationPending: false,
    });
  });

  it("refreshes actual cohort and crash observations after mutations", async () => {
    const client = runtimeClient();
    await readRuntimeSnapshot(client);
    client.getCohort.mockReturnValue("changed-cohort");
    client.getCrashHistory.mockReturnValue([]);
    expect(await readRuntimeSnapshot(client)).toMatchObject({
      currentCohort: "changed-cohort",
      crashHistoryCount: "0",
    });
  });

  it.each(["getLaunchInfo", "getCrashHistory", "isChannelSwitched"] as const)(
    "surfaces %s failures instead of fabricating an empty native state",
    async (method) => {
      const client = runtimeClient();
      client[method].mockImplementation(() => {
        throw new Error("native observation failed");
      });
      await expect(readRuntimeSnapshot(client)).rejects.toThrow(
        "native observation failed",
      );
    },
  );

  it("reports an absent update and a real adoption without scenario-specific rewrites", async () => {
    const checkForUpdate = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(update({ transitionKind: "ADOPT_RELEASE" }));
    const options = { updateStrategy: "appVersion" } as const;
    expect(
      await installCheckedUpdate({ checkForUpdate }, options, "chain-current"),
    ).toBe("chain-current -> no-update");
    expect(
      await installCheckedUpdate({ checkForUpdate }, options, "chain-current"),
    ).toBe("chain-current -> adopted ID release-B");
  });

  it.each(["HTTP 499", "request timed out"])(
    "does not translate %s into no-update",
    async (message) => {
      const checkForUpdate = vi.fn().mockRejectedValue(new Error(message));
      await expect(
        installCheckedUpdate(
          { checkForUpdate },
          { updateStrategy: "appVersion" },
          "current-channel",
        ),
      ).rejects.toThrow(message);
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, null])(
    "does not reload an arbitrary staged update when force is %s",
    async (force) => {
      const client = {
        checkForUpdate: vi
          .fn()
          .mockResolvedValue(force === null ? null : update()),
        getLaunchInfo: vi.fn().mockResolvedValue(launch),
        reload: vi.fn(),
      };
      await applyForcedUpdate(client, () => false);
      expect(client.reload).not.toHaveBeenCalled();
    },
  );

  it("reloads only after a successful forced installation", async () => {
    const updateBundle = vi.fn().mockResolvedValue(false);
    const client = {
      checkForUpdate: vi
        .fn()
        .mockResolvedValue(update({ shouldForceUpdate: true, updateBundle })),
      getLaunchInfo: vi.fn().mockResolvedValue(launch),
      reload: vi.fn(),
    };
    await applyForcedUpdate(client, () => false);
    expect(client.reload).not.toHaveBeenCalled();
    updateBundle.mockRejectedValueOnce(new Error("installation rejected"));
    await expect(applyForcedUpdate(client, () => false)).rejects.toThrow(
      "installation rejected",
    );
    expect(client.reload).not.toHaveBeenCalled();
    updateBundle.mockResolvedValueOnce(true);
    await applyForcedUpdate(client, () => false);
    expect(client.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload an already running forced Release", async () => {
    const updateBundle = vi.fn();
    const client = {
      checkForUpdate: vi.fn().mockResolvedValue(
        update({
          shouldForceUpdate: true,
          bundleId: "bundle-A",
          releaseId: "release-A",
          updateBundle,
        }),
      ),
      getLaunchInfo: vi.fn().mockResolvedValue(launch),
      reload: vi.fn(),
    };
    await applyForcedUpdate(client, () => false);
    expect(updateBundle).not.toHaveBeenCalled();
    expect(client.reload).not.toHaveBeenCalled();
  });
});
