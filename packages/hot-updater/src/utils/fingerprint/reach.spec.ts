import { assembleServer } from "@hot-updater/cli-tools";
import { createMemoryAdapter, type ReleaseRow } from "@hot-updater/plugin-core";
import { createBundleFixture } from "@hot-updater/test-utils";
import { describe, expect, it, vi } from "vitest";

import {
  describeFingerprintReach,
  findOtherServedFingerprints,
  RECENT_RELEASE_LIMIT,
} from "./reach";

const release = (
  fingerprintHash: string | null,
  createdAtMs: number,
  strategy: ReleaseRow["strategy"] = "FINGERPRINT",
) =>
  ({
    strategy,
    fingerprint_hash: fingerprintHash,
    created_at_ms: createdAtMs,
  }) as ReleaseRow;

describe("findOtherServedFingerprints", () => {
  it("lists the other fingerprints the channel's newest releases target, newest first", async () => {
    const listReleases = vi.fn(async () => [
      release("current", 5),
      release("previous", 4),
      release("previous", 3),
      release(null, 2, "APP_VERSION"),
      release("oldest", 1),
    ]);

    await expect(
      findOtherServedFingerprints({
        core: {
          findChannelByName: async () => ({ id: "c1", name: "production" }),
          listReleases,
        },
        channel: "production",
        platform: "ios",
        fingerprintHash: "current",
      }),
    ).resolves.toEqual([
      { hash: "previous", latestReleaseAtMs: 4 },
      { hash: "oldest", latestReleaseAtMs: 1 },
    ]);
    expect(listReleases).toHaveBeenCalledWith({
      filter: {
        kind: "channelPlatform",
        channelId: "c1",
        platform: "ios",
        enabled: true,
      },
      order: "desc",
      limit: RECENT_RELEASE_LIMIT,
    });
  });

  it("reads nothing more for a channel that doesn't exist yet", async () => {
    const listReleases = vi.fn();

    await expect(
      findOtherServedFingerprints({
        core: { findChannelByName: async () => null, listReleases },
        channel: "beta",
        platform: "android",
        fingerprintHash: "current",
      }),
    ).resolves.toEqual([]);
    expect(listReleases).not.toHaveBeenCalled();
  });
});

describe("describeFingerprintReach", () => {
  it("names the fingerprints left out and the build they need", () => {
    expect(
      describeFingerprintReach({
        others: [
          {
            hash: "9d3ed05a32aa",
            latestReleaseAtMs: Date.UTC(2026, 9, 10),
          },
        ],
        label: "iOS",
        channel: "production",
        fingerprintHash: "173da99ae28e",
      }),
    ).toBe(
      "iOS builds on other fingerprints in production won't receive this update: 9d3ed05a32 (latest release 2026-10-10). They receive it after users install a build with fingerprint 173da99ae2.",
    );
  });

  it("says nothing when every served build gets the update", () => {
    expect(
      describeFingerprintReach({
        others: [],
        label: "Android",
        channel: "production",
        fingerprintHash: "173da99ae28e",
      }),
    ).toBeNull();
  });
});

describe("findOtherServedFingerprints on a real core", () => {
  it("reads the channel's newest enabled fingerprint releases", async () => {
    const { core } = assembleServer({
      database: { name: "memory", adapter: createMemoryAdapter() },
    });
    const deploy = async (
      suffix: string,
      fingerprintHash: string,
      channel = "production",
    ) => {
      const [deployed] = await core.deploy([
        {
          bundle: createBundleFixture(suffix),
          release: {
            channel,
            enabled: true,
            fingerprintHash,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: null,
          },
        },
      ]);
      return deployed!.release!.id;
    };
    await deploy("101", "old-build");
    await deploy("102", "previous-build");
    const disabled = await deploy("103", "disabled-build");
    await core.updateReleasePolicy({
      releaseId: disabled,
      patch: { enabled: false },
    });
    await deploy("104", "staging-build", "staging");
    await deploy("105", "current-build");

    const others = await findOtherServedFingerprints({
      core,
      channel: "production",
      platform: "ios",
      fingerprintHash: "current-build",
    });

    expect(others.map(({ hash }) => hash)).toEqual([
      "previous-build",
      "old-build",
    ]);
  });
});
