import { loadConfig } from "@hot-updater/cli-tools";
import { describe, expect, it, vi } from "vitest";

import {
  appendFingerprintExtraSources,
  describeFingerprintEngineChange,
  ensureFingerprintConfig,
  getFingerprintEngineChange,
  getFingerprintInputs,
} from "./common";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig: vi.fn(),
}));

describe("ensureFingerprintConfig", () => {
  it("loads the config as it is, reading no secret", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      updateStrategy: "fingerprint",
      build: () => ({ name: "bare", build: vi.fn() }),
      fingerprint: {},
    } as never);

    await ensureFingerprintConfig([]);

    expect(vi.mocked(loadConfig).mock.calls).toEqual([[null]]);
  });
});

const SHARED_SOURCE = "keys/public-key.pem";
const IOS_ONLY_SOURCE = "ios/Config.xcconfig";

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
      "To keep updating iOS builds you already shipped, go back to @expo/fingerprint@0.20.14. If the fingerprint still differs with it, native inputs changed too, and builds you shipped need a rebuild. Otherwise run `npx hot-updater fingerprint create`, then rebuild the iOS app.",
    );
    expect(
      describeFingerprintEngineChange(change, "iOS", true).resolution,
    ).toBe(
      "fingerprint.json now records the @expo/fingerprint@0.21.5 hash. To keep updating iOS builds you already shipped, go back to @expo/fingerprint@0.20.14 and run `npx hot-updater fingerprint create` again, or restore the previous fingerprint.json. If the fingerprint still differs with it, native inputs changed too, and builds you shipped need a rebuild. Otherwise rebuild the iOS app.",
    );
  });
});

describe("getFingerprintInputs", () => {
  it("records the adapter whose fingerprint computed the hash", () => {
    const provider = async () => ({ hash: "h", sources: [] });

    expect(getFingerprintInputs({ adapter: "bare", provider }).adapter).toBe(
      "bare",
    );
    // An adapter without a fingerprint gets React Native CLI's.
    expect(getFingerprintInputs({ adapter: "custom" }).adapter).toBe(
      "react-native",
    );
  });
});
