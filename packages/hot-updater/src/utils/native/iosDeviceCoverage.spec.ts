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
import {
  type AppleDeviceState,
  readIosDeviceCoverage,
} from "./iosDeviceCoverage";

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

const ISSUER = "issuer-a";
const BUILT_AT = 1_000_000;
const NOW = 2_000_000;

/**
 * A registry row as the registry holds it, approved and registered well
 * before the build: no scenario here moves a timestamp, as nothing on the
 * reuse path does.
 */
const device = (
  udid: string,
  name: string,
  {
    status = "registered",
    issuer = status === "registered" ? ISSUER : null,
    appleError = null,
  }: {
    status?: IosDeviceRow["status"];
    issuer?: string | null;
    appleError?: string | null;
  } = {},
): IosDeviceRow =>
  ({
    id: `device-${udid}`,
    udid,
    name,
    status,
    approved_at_ms: BUILT_AT - 10_000,
    registered_at_ms: status === "registered" ? BUILT_AT - 5_000 : null,
    apple_issuer_id: issuer,
    apple_error: appleError,
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

/** Apple's account, by UDID and status. */
const atApple = (devices: Record<string, string>): AppleDeviceState => ({
  kind: "read",
  issuerId: ISSUER,
  devices: new Map(
    Object.entries(devices).map(([udid, status]) => [udid, { status }]),
  ),
});

const build = {
  id: "build-1",
  artifact_kind: "ipa",
  export_method: "ad-hoc",
  artifact_storage_uri: "storage://native-builds/ios/build-1/App.ipa",
  byte_size: 4,
  min_bundle_id: "019a0000-0000-7000-8000-000000000001",
  created_at_ms: BUILT_AT,
} as NativeBuildRow;

/**
 * The registry: its rows, and the Apple account it belongs to, the scheme's
 * by default.
 */
const registry = (
  rows: readonly IosDeviceRow[],
  account: string | null = ISSUER,
) => ({
  listIosDevices: vi.fn(async ({ status }: { status?: string }) =>
    rows.filter((row) => row.status === status),
  ),
  findIosDeviceAccount: vi.fn(async () =>
    account === null ? null : { issuerId: account },
  ),
  claimIosDeviceAccount: vi.fn(),
});

/** One preview's check of the found `.ipa`, as `find --json` runs it. */
const check = (
  rows: readonly IosDeviceRow[] | ReturnType<typeof registry>,
  apple: AppleDeviceState | (() => Promise<AppleDeviceState>),
  overrides: Partial<NativeBuildRow> = {},
) =>
  readIosDeviceCoverage(
    {
      core: Array.isArray(rows) ? registry(rows) : (rows as never),
      storage: {} as StorageAdapter,
    },
    { ...build, ...overrides },
    typeof apple === "function" ? apple : async () => apple,
    NOW,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNativeBuildDownloadUrl).mockResolvedValue(null);
  vi.mocked(downloadNativeBuild).mockImplementation(
    async (_storage, _build, file) => {
      await fs.promises.writeFile(file, "ipa!");
      return { byteSize: 4 };
    },
  );
  vi.mocked(readIpaInstallInfo).mockResolvedValue(ipa(["a"]));
});

describe("a found ad hoc .ipa and Apple's current state", () => {
  it("reuses an .ipa that lists every device, without asking Apple", async () => {
    const apple = vi.fn(async () => atApple({}));
    await expect(check([device("a", "Ana's iPhone")], apple)).resolves.toEqual({
      reusable: true,
      reason: null,
      missing: [],
      waiting: [],
    });
    expect(apple).not.toHaveBeenCalled();
  });

  it("builds again once Apple enables a device it had disabled, with nothing in the registry changed", async () => {
    const rows = [device("a", "Ana's iPhone"), device("b", "Bo's iPad")];

    // While Apple has it disabled, no build could add it.
    const disabled = await check(
      rows,
      atApple({ a: "ENABLED", b: "DISABLED" }),
    );
    expect(disabled).toMatchObject({ reusable: true, missing: [] });
    // Enabled at Apple: the next preview builds, though the build is older.
    await expect(
      check(rows, atApple({ a: "ENABLED", b: "ENABLED" })),
    ).resolves.toMatchObject({
      reusable: false,
      reason: "missing",
      missing: ["Bo's iPad"],
    });
    expect(disabled?.waiting).toEqual([
      { name: "Bo's iPad", reason: "disabled at Apple" },
    ]);
  });

  it("builds again once signing is repaired after the build, for a device approved before it", async () => {
    const rows = [
      device("a", "Ana's iPhone"),
      device("b", "Bo's iPad", { status: "approved" }),
    ];

    const pinned = await check(rows, {
      kind: "unavailable",
      reason: "the scheme pins a provisioning profile",
    });
    expect(pinned).toMatchObject({ reusable: true, missing: [] });
    // Automatic signing with an API key now: a build registers it first.
    await expect(check(rows, atApple({ a: "ENABLED" }))).resolves.toMatchObject(
      { reusable: false, reason: "missing", missing: ["Bo's iPad"] },
    );
    expect(pinned?.waiting).toEqual([
      { name: "Bo's iPad", reason: "the scheme pins a provisioning profile" },
    ]);
  });

  it("builds again for an approved device Apple has enabled already", async () => {
    await expect(
      check(
        [device("b", "Bo's iPad", { status: "approved" })],
        atApple({ b: "ENABLED" }),
      ),
    ).resolves.toMatchObject({ reusable: false, missing: ["Bo's iPad"] });
  });

  it.each([
    [
      "refused before",
      device("b", "Bo's iPad", {
        status: "approved",
        appleError: "The device limit is reached.",
      }),
      {},
      "Apple refused it: The device limit is reached.",
    ],
    [
      "gone from the account",
      device("b", "Bo's iPad"),
      {},
      "gone from the Apple account",
    ],
    [
      "another account's",
      device("b", "Bo's iPad", { issuer: "issuer-b" }),
      { b: "ENABLED" },
      "in another Apple account",
    ],
  ] as const)(
    "doesn't build again for a device %s",
    async (_, row, apple, reason) => {
      await expect(check([row], atApple(apple))).resolves.toEqual({
        reusable: true,
        reason: null,
        missing: [],
        waiting: [{ name: "Bo's iPad", reason }],
      });
    },
  );

  describe("a registry another Apple account holds", () => {
    // Account A claimed the registry; the scheme signs with ISSUER, account B.
    const OTHER = "issuer-other";

    it("waits for a newly approved device on every check, and asks for no build, whatever Apple says", async () => {
      const held = registry(
        [
          device("a", "Ana's iPhone"),
          device("b", "Bo's iPad", { status: "approved" }),
        ],
        OTHER,
      );
      for (const apple of [
        atApple({ a: "ENABLED" }),
        atApple({ a: "ENABLED", b: "ENABLED" }),
      ]) {
        for (let run = 0; run < 2; run += 1) {
          await expect(check(held, apple)).resolves.toMatchObject({
            reusable: true,
            reason: null,
            missing: [],
          });
        }
      }
      const result = await check(held, atApple({ a: "ENABLED" }));
      expect(result?.waiting).toEqual([
        {
          name: "Bo's iPad",
          reason: "the registry is another Apple account's",
        },
      ]);
      // Reading it claims nothing.
      expect(held.claimIosDeviceAccount).not.toHaveBeenCalled();
    });

    it("keeps holding it with none of its device rows left", async () => {
      const held = registry(
        [device("b", "Bo's iPad", { status: "approved" })],
        OTHER,
      );
      await expect(check(held, atApple({}))).resolves.toMatchObject({
        reusable: true,
        missing: [],
        waiting: [
          {
            name: "Bo's iPad",
            reason: "the registry is another Apple account's",
          },
        ],
      });
    });

    it("lets a registry no account holds yet go to the scheme's", async () => {
      await expect(
        check(
          registry([device("b", "Bo's iPad", { status: "approved" })], null),
          atApple({}),
        ),
      ).resolves.toMatchObject({ reusable: false, missing: ["Bo's iPad"] });
    });
  });

  it("waits, saying so, when Apple can't be read", async () => {
    await expect(
      check([device("b", "Bo's iPad", { status: "approved" })], async () => {
        throw new Error("No secret asc-api-key.");
      }),
    ).resolves.toEqual({
      reusable: true,
      reason: null,
      missing: [],
      waiting: [
        {
          name: "Bo's iPad",
          reason: "Apple's devices couldn't be read: No secret asc-api-key.",
        },
      ],
    });
  });

  it("builds again for an expired profile, and for one that can't be read", async () => {
    vi.mocked(readIpaInstallInfo).mockResolvedValueOnce(
      ipa(["a"], { expiresAtMs: NOW }),
    );
    await expect(
      check([device("a", "Ana's iPhone")], atApple({})),
    ).resolves.toMatchObject({ reusable: false, reason: "expired" });
    vi.mocked(readIpaInstallInfo).mockRejectedValueOnce(
      new NativeArtifactError("UNREADABLE", "corrupt"),
    );
    await expect(check([], atApple({}))).resolves.toMatchObject({
      reusable: false,
      reason: "unreadable",
    });
  });

  it("reads the stored .ipa through a download when the storage gives no URL", async () => {
    await check([device("a", "Ana's iPhone")], atApple({}));
    expect(downloadNativeBuild).toHaveBeenCalledOnce();
  });

  it("reads nothing for another artifact, an App Store .ipa, or one that lists no devices", async () => {
    for (const overrides of [
      { artifact_kind: "apk" },
      { export_method: "app-store" },
    ] as Partial<NativeBuildRow>[]) {
      await expect(check([], atApple({}), overrides)).resolves.toBeNull();
    }
    expect(downloadNativeBuild).not.toHaveBeenCalled();
    vi.mocked(readIpaInstallInfo).mockResolvedValueOnce(
      ipa([], { distribution: "enterprise" }),
    );
    await expect(check([], atApple({}))).resolves.toBeNull();
  });
});
