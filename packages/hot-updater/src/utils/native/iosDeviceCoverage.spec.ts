import fs from "fs";

import type {
  IosDeviceRow,
  NativeBuildRow,
  StorageAdapter,
} from "@hot-updater/plugin-core";
import {
  type IpaInstallInfo,
  NativeArtifactError,
  readIpaInstallInfo,
} from "@hot-updater/protocol/native-artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  downloadNativeBuild,
  resolveNativeBuildDownloadUrl,
} from "./downloadNativeBuild";
import { iosDeviceCoverage, readIosDeviceCoverage } from "./iosDeviceCoverage";

vi.mock("@hot-updater/protocol/native-artifact", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@hot-updater/protocol/native-artifact")
  >()),
  readIpaInstallInfo: vi.fn(),
}));
vi.mock("./downloadNativeBuild", () => ({
  downloadNativeBuild: vi.fn(),
  resolveNativeBuildDownloadUrl: vi.fn(),
}));

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
    // A MIN_BUNDLE_ID that names no time: the registration's decides.
    build: { min_bundle_id: "not-a-uuid", created_at_ms: createdAt },
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

  it("counts from the MIN_BUNDLE_ID's time, when the build started compiling", () => {
    // Issued before the build registered, after its device step.
    const minBundleId = `${(BUILT_AT - 100)
      .toString(16)
      .padStart(12, "0")
      .replace(/^(.{8})/, "$1-")}-7000-8000-000000000000`;
    const midBuild = device("b", "Bo's iPad", {
      status: "approved",
      approvedAt: BUILT_AT - 50,
    });
    expect(
      iosDeviceCoverage({
        build: { min_bundle_id: minBundleId, created_at_ms: BUILT_AT },
        info: ipa([]),
        devices: [midBuild],
        now: NOW,
      }),
    ).toMatchObject({ reusable: false, missing: ["Bo's iPad"] });
  });

  it("says nothing of an .ipa that lists no devices", () => {
    expect(coverage(ipa([], { distribution: "store" }), [])).toBeNull();
    expect(coverage(ipa([], { distribution: "enterprise" }), [])).toBeNull();
  });
});

describe("readIosDeviceCoverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const build = {
    id: "build-1",
    artifact_kind: "ipa",
    export_method: "ad-hoc",
    artifact_storage_uri: "storage://native-builds/ios/build-1/App.ipa",
    byte_size: 4,
    min_bundle_id: "not-a-uuid",
    created_at_ms: BUILT_AT,
  } as NativeBuildRow;
  const core = (rows: Record<string, IosDeviceRow[]>) => ({
    listIosDevices: vi.fn(
      async ({ status }: { status?: string }) => rows[status ?? ""] ?? [],
    ),
  });

  beforeEach(() => {
    vi.mocked(resolveNativeBuildDownloadUrl).mockResolvedValue(null);
    vi.mocked(downloadNativeBuild).mockImplementation(
      async (_storage, _build, file) => {
        await fs.promises.writeFile(file, "ipa!");
        return { byteSize: 4 };
      },
    );
    vi.mocked(readIpaInstallInfo).mockResolvedValue(ipa(["a"]));
  });

  it("reads a stored ad hoc .ipa through a download when the storage gives no URL, and the registry's devices", async () => {
    const registry = core({
      registered: [device("a", "Ana's iPhone")],
      approved: [
        device("b", "Bo's iPad", {
          status: "approved",
          approvedAt: BUILT_AT + 1,
        }),
      ],
    });

    await expect(
      readIosDeviceCoverage(
        { core: registry, storage: {} as StorageAdapter },
        build,
        NOW,
      ),
    ).resolves.toEqual({
      reusable: false,
      reason: "missing",
      missing: ["Bo's iPad"],
      waiting: [],
    });
    expect(downloadNativeBuild).toHaveBeenCalledOnce();
    expect(registry.listIosDevices).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved" }),
    );
  });

  it("says unreadable for a profile it can't read", async () => {
    vi.mocked(readIpaInstallInfo).mockRejectedValue(
      new NativeArtifactError("UNREADABLE", "corrupt"),
    );
    await expect(
      readIosDeviceCoverage(
        { core: core({}), storage: {} as StorageAdapter },
        build,
        NOW,
      ),
    ).resolves.toMatchObject({ reusable: false, reason: "unreadable" });
  });

  it("reads nothing for another artifact or an App Store .ipa", async () => {
    const registry = core({});
    for (const other of [
      { ...build, artifact_kind: "apk" },
      { ...build, export_method: "app-store" },
    ] as NativeBuildRow[]) {
      await expect(
        readIosDeviceCoverage(
          { core: registry, storage: {} as StorageAdapter },
          other,
          NOW,
        ),
      ).resolves.toBeNull();
    }
    expect(downloadNativeBuild).not.toHaveBeenCalled();
    expect(registry.listIosDevices).not.toHaveBeenCalled();
  });
});
