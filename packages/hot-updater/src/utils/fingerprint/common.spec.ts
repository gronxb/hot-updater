import { getCwd } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import {
  appendFingerprintExtraSources,
  getOtaFingerprintOptions,
} from "./common";

const SHARED_SOURCE =
  "packages/hot-updater/src/utils/fingerprint/processExtraSources.ts";
const IOS_ONLY_SOURCE = "packages/hot-updater/src/utils/fingerprint/common.ts";

const getExtraSourceIds = async (
  platform: "ios" | "android",
  extraSources: Parameters<typeof getOtaFingerprintOptions>[2]["extraSources"],
) => {
  const cwd = getCwd();
  const { extraSources: processed } = await getOtaFingerprintOptions(
    platform,
    cwd,
    { platform, extraSources },
  );
  return processed.map((source) =>
    source.type === "dir" ? source.filePath : source.id,
  );
};

describe("getOtaFingerprintOptions", () => {
  it("applies array extraSources to both platforms", async () => {
    await expect(getExtraSourceIds("ios", [SHARED_SOURCE])).resolves.toEqual([
      SHARED_SOURCE,
    ]);
    await expect(
      getExtraSourceIds("android", [SHARED_SOURCE]),
    ).resolves.toEqual([SHARED_SOURCE]);
  });

  it("keeps platform-scoped extraSources out of the other platform", async () => {
    const extraSources = {
      ios: [IOS_ONLY_SOURCE],
      android: [SHARED_SOURCE],
    };

    await expect(getExtraSourceIds("ios", extraSources)).resolves.toEqual([
      IOS_ONLY_SOURCE,
    ]);
    await expect(getExtraSourceIds("android", extraSources)).resolves.toEqual([
      SHARED_SOURCE,
    ]);
  });

  it("adds no extra sources for a platform without entries", async () => {
    await expect(
      getExtraSourceIds("android", { ios: [IOS_ONLY_SOURCE] }),
    ).resolves.toEqual([]);
  });
});

describe("appendFingerprintExtraSources", () => {
  it("adds native config sources to both platform fingerprints", () => {
    expect(
      appendFingerprintExtraSources({ ios: [IOS_ONLY_SOURCE], android: [] }, [
        SHARED_SOURCE,
      ]),
    ).toEqual({
      ios: [IOS_ONLY_SOURCE, SHARED_SOURCE],
      android: [SHARED_SOURCE],
    });
  });

  it("does not duplicate an existing native config source", () => {
    expect(
      appendFingerprintExtraSources([SHARED_SOURCE], [SHARED_SOURCE]),
    ).toEqual([SHARED_SOURCE]);
  });
});
