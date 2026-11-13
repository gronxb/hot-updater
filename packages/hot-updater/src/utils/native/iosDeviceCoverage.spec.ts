import type { IosDeviceRow } from "@hot-updater/plugin-core";
import type { IpaInstallInfo } from "@hot-updater/protocol/native-artifact";
import { describe, expect, it } from "vitest";

import { iosDeviceCoverage } from "./iosDeviceCoverage";

const BUILT_AT = 1_000_000;
const NOW = 2_000_000;

const device = (
  udid: string,
  name: string,
  {
    status = "registered",
    approvedAt = BUILT_AT - 10,
    registeredAt = status === "registered" ? BUILT_AT - 5 : null,
  }: {
    status?: IosDeviceRow["status"];
    approvedAt?: number | null;
    registeredAt?: number | null;
  } = {},
): IosDeviceRow =>
  ({
    id: `device-${udid}`,
    udid,
    name,
    status,
    approved_at_ms: approvedAt,
    registered_at_ms: registeredAt,
  }) as IosDeviceRow;

const ipa = (
  devices: readonly string[],
  overrides: Partial<IpaInstallInfo> = {},
): IpaInstallInfo =>
  ({
    bundleId: "com.example.app",
    bundleVersion: "1",
    title: "Example",
    distribution: "ad-hoc",
    devices,
    expiresAtMs: NOW + 1_000,
    ...overrides,
  }) as IpaInstallInfo;

const coverage = (
  info: IpaInstallInfo | null,
  devices: readonly IosDeviceRow[],
  createdAt = BUILT_AT,
) =>
  iosDeviceCoverage({
    build: { created_at_ms: createdAt },
    info,
    devices,
    now: NOW,
  });

describe("iosDeviceCoverage", () => {
  it("reuses an .ipa that lists every approved device", () => {
    expect(
      coverage(ipa(["a", "b"]), [
        device("a", "Ana's iPhone"),
        device("b", "Bo's iPad"),
      ]),
    ).toEqual({ reusable: true, reason: null, missing: [], waiting: [] });
  });

  it("builds again for a device approved after the build, which a build registers with Apple first", () => {
    const later = device("b", "Bo's iPad", {
      status: "approved",
      approvedAt: BUILT_AT + 1,
    });
    expect(coverage(ipa(["a"]), [device("a", "Ana's iPhone"), later])).toEqual({
      reusable: false,
      reason: "missing",
      missing: ["Bo's iPad"],
      waiting: [],
    });
  });

  it("builds again for a device Apple enabled after the build", () => {
    const enabled = device("b", "Bo's iPad", { registeredAt: BUILT_AT + 1 });
    expect(coverage(ipa(["a"]), [enabled])).toMatchObject({
      reusable: false,
      missing: ["Bo's iPad"],
    });
  });

  it.each([
    ["Apple hasn't enabled it", { status: "approved" as const }],
    ["the scheme couldn't add it", { status: "registered" as const }],
  ])(
    "doesn't build again for a device its build already had the chance to add: %s",
    (_, options) => {
      expect(coverage(ipa([]), [device("b", "Bo's iPad", options)])).toEqual({
        reusable: true,
        reason: null,
        missing: [],
        waiting: ["Bo's iPad"],
      });
    },
  );

  it("doesn't build again on the next run when the new build still lacks the device", () => {
    const pending = device("b", "Bo's iPad", {
      status: "approved",
      approvedAt: BUILT_AT + 1,
    });
    // The first run builds; the build Apple didn't enable the device for is
    // newer than the approval, so the next run reuses it.
    expect(coverage(ipa([]), [pending]).reusable).toBe(false);
    expect(coverage(ipa([]), [pending], BUILT_AT + 2)).toEqual({
      reusable: true,
      reason: null,
      missing: [],
      waiting: ["Bo's iPad"],
    });
  });

  it("builds again for an expired profile, and for one that can't be read", () => {
    expect(
      coverage(ipa(["a"], { expiresAtMs: NOW }), [device("a", "Ana's iPhone")]),
    ).toMatchObject({ reusable: false, reason: "expired" });
    expect(coverage(null, [])).toMatchObject({
      reusable: false,
      reason: "unreadable",
    });
  });

  it("says nothing of an .ipa that lists no devices", () => {
    expect(coverage(ipa([], { distribution: "store" }), [])).toBeNull();
    expect(coverage(ipa([], { distribution: "enterprise" }), [])).toBeNull();
  });
});
