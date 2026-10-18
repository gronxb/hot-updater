import { describe, expect, it, vi } from "vitest";

import type { FingerprintResult, FingerprintSource } from "./common";
import { getFingerprintDiff, summarizeFingerprintDiff } from "./diff";
import { nativeFingerprint } from "./nativeFingerprint";

vi.mock("./nativeFingerprint", () => ({ nativeFingerprint: vi.fn() }));

const file = (filePath: string, hash: string | null): FingerprintSource => ({
  type: "file",
  filePath,
  reasons: ["test"],
  hash,
});

const contents = (id: string, hash: string): FingerprintSource => ({
  type: "contents",
  id,
  contents: id,
  reasons: ["test"],
  hash,
});

const contentsOf = (id: string, value: string): FingerprintSource => ({
  type: "contents",
  id,
  contents: value,
  reasons: ["test"],
  hash: value,
});

const fingerprint = (sources: FingerprintSource[]): FingerprintResult => ({
  hash: "hash",
  sources,
});

describe("getFingerprintDiff", () => {
  it("lists the sources added, removed, and changed since the saved fingerprint", async () => {
    vi.mocked(nativeFingerprint).mockResolvedValue(
      fingerprint([
        contents("runtime", "rn-0.86"),
        file("src/specs/NativeDevice.ts", "same"),
        file("ios", null),
        file("patches/react-native-screens+4.25.2.patch", "patch"),
      ]),
    );

    const diff = await getFingerprintDiff(
      fingerprint([
        contents("runtime", "rn-0.85"),
        file("src/specs/NativeDevice.ts", "same"),
        file("ios", null),
        contents("dependency:react-native-camera", "camera"),
      ]),
      { platform: "ios" },
    );

    expect(diff).toEqual([
      {
        op: "changed",
        beforeSource: contents("runtime", "rn-0.85"),
        afterSource: contents("runtime", "rn-0.86"),
      },
      {
        op: "removed",
        removedSource: contents("dependency:react-native-camera", "camera"),
      },
      {
        op: "added",
        addedSource: file("patches/react-native-screens+4.25.2.patch", "patch"),
      },
    ]);
    expect(nativeFingerprint).toHaveBeenCalledWith(expect.any(String), {
      platform: "ios",
    });
  });

  it("summarizes values before and after, and files by path", () => {
    const dependency = (version: string) =>
      contentsOf(
        "dependency:react-native-screens",
        `react-native-screens@${version}`,
      );
    const setting = (value: string) =>
      contentsOf("setting:android:hermesEnabled", value);

    expect(
      summarizeFingerprintDiff([
        {
          op: "changed",
          beforeSource: dependency("4.25.2"),
          afterSource: dependency("4.26.0"),
        },
        {
          op: "changed",
          beforeSource: setting("true"),
          afterSource: setting("false"),
        },
        {
          op: "changed",
          beforeSource: file("src/specs/NativeDevice.ts", "a"),
          afterSource: file("src/specs/NativeDevice.ts", "b"),
        },
        {
          op: "added",
          addedSource: contentsOf("nativeVersion", "2"),
        },
        {
          op: "removed",
          removedSource: contentsOf(
            "dependency:react-native-camera",
            "react-native-camera@4.2.1",
          ),
        },
      ]),
    ).toEqual({
      added: ["nativeVersion=2"],
      removed: ["react-native-camera@4.2.1"],
      changed: [
        "react-native-screens 4.25.2 → 4.26.0",
        "android:hermesEnabled true → false",
        "src/specs/NativeDevice.ts",
      ],
    });
  });
});
