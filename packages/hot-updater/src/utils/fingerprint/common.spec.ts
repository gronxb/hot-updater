import { getCwd } from "@hot-updater/cli-tools";
import { describe, expect, it, vi } from "vitest";

import {
  appendFingerprintExtraSources,
  describeFingerprintEngineChange,
  getFingerprintEngineChange,
  getOtaFingerprintOptions,
} from "./common";

vi.mock("./dependency", () => ({
  loadExpoFingerprint: () => import("@expo/fingerprint"),
}));

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

describe("getFingerprintEngineChange", () => {
  it("returns both engines when they differ", () => {
    expect(
      getFingerprintEngineChange(
        { engine: "@expo/fingerprint@0.20.14" },
        { engine: "@expo/fingerprint@0.21.5" },
      ),
    ).toEqual({
      before: "@expo/fingerprint@0.20.14",
      after: "@expo/fingerprint@0.21.5",
    });
  });

  it("returns null for the same engine or an unrecorded one", () => {
    const engine = { engine: "@expo/fingerprint@0.21.5" };
    expect(getFingerprintEngineChange(engine, engine)).toBeNull();
    expect(getFingerprintEngineChange({}, engine)).toBeNull();
    expect(getFingerprintEngineChange(null, engine)).toBeNull();
  });

  it("counts an unrecorded engine as @expo/fingerprint against another engine", () => {
    expect(
      getFingerprintEngineChange({}, { engine: "hot-updater/interface@1" }),
    ).toEqual({
      before: "@expo/fingerprint",
      after: "hot-updater/interface@1",
    });
  });
});

describe("describeFingerprintEngineChange", () => {
  it("suggests going back for another version of the same engine", () => {
    expect(
      describeFingerprintEngineChange(
        {
          before: "@expo/fingerprint@0.20.14",
          after: "@expo/fingerprint@0.21.5",
        },
        "iOS",
      ).resolution,
    ).toContain("go back to @expo/fingerprint@0.20.14");
  });

  it("asks for a rebuild when the engine itself changed", () => {
    expect(
      describeFingerprintEngineChange(
        { before: "@expo/fingerprint", after: "hot-updater/interface@1" },
        "Android",
      ).resolution,
    ).toBe(
      "Run `npx hot-updater fingerprint create`, then rebuild the Android app. Builds you already shipped keep the old fingerprint and receive no updates until users install the new build.",
    );
  });
});

describe("describeFingerprintEngineChange", () => {
  const change = {
    before: "@expo/fingerprint@0.20.14",
    after: "@expo/fingerprint@0.21.5",
  };

  it("tells fingerprint create users to rerun it after going back", () => {
    expect(describeFingerprintEngineChange(change, "iOS").resolution).toBe(
      "To keep updating iOS builds you already shipped, go back to @expo/fingerprint@0.20.14. Otherwise run `npx hot-updater fingerprint create`, then rebuild the iOS app.",
    );
    expect(
      describeFingerprintEngineChange(change, "iOS", true).resolution,
    ).toBe(
      "fingerprint.json now records the @expo/fingerprint@0.21.5 hash. To keep updating iOS builds you already shipped, go back to @expo/fingerprint@0.20.14 and run `npx hot-updater fingerprint create` again, or restore the previous fingerprint.json. Otherwise rebuild the iOS app.",
    );
  });
});
