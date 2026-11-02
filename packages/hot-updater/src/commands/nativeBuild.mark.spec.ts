import {
  type Bundle,
  createStorageAdapter,
  type NativeBuildRegistration,
} from "@hot-updater/plugin-core";
import { createBundleFixture } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBundleDiff } from "../utils/createBundleDiff";
import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";

const { loadConfig, loadServer, log } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadServer: vi.fn(),
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getBundleSigningPublicKey: vi.fn(async () => "public-key"),
  loadConfig,
  p: { isCancel: () => false, log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/createBundleDiff", () => ({ createBundleDiff: vi.fn() }));

const databaseHarness = createDatabaseHarness();

const CHANNEL = "production";
const buildId = (n: number) =>
  `01900000-0000-7000-8000-00000000b${String(n).padStart(3, "0")}`;
const builtInId = (n: number) =>
  `01900000-0000-7000-8000-00000000a${String(n).padStart(3, "0")}`;
const otaId = (n: number) =>
  `0195000${n}-0000-7000-8000-00000000c${String(n).padStart(3, "0")}`;

const register = (
  n: number,
  overrides: Partial<NativeBuildRegistration> = {},
) =>
  databaseHarness.core.registerNativeBuild({
    id: buildId(n),
    minBundleId: builtInId(n),
    platform: "ios",
    channel: CHANNEL,
    fingerprintHash: null,
    appVersion: "1.7.0",
    gitCommitHash: null,
    buildKey: null,
    buildNumber: String(60 + n),
    artifact: {
      kind: "ipa",
      storageUri: `storage://native-builds/ios/${n}/App.ipa`,
      byteSize: 1_000,
    },
    embeddedBundle: {
      manifestStorageUri: `storage://bundles/${n}/manifest.json`,
      manifestFileHash: "manifest-hash",
      assetBaseStorageUri: "storage://assets",
    },
    ...overrides,
  } as NativeBuildRegistration);

const deployOta = async (
  id: string,
  {
    channel = CHANNEL,
    patches = [],
    targetAppVersion = "1.7.0",
  }: {
    readonly channel?: string;
    readonly patches?: NonNullable<Bundle["patches"]>;
    readonly targetAppVersion?: string;
  } = {},
) => {
  await databaseHarness.core.deploy([
    {
      bundle: { ...createBundleFixture("1"), id, platform: "ios", patches },
      release: {
        channel,
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion,
      },
    },
  ]);
};

const lines = (method: keyof typeof log) =>
  log[method].mock.calls.map(([line]) => String(line));
const output = () =>
  JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

const storage = createStorageAdapter({
  name: "test",
  protocol: "storage",
  delete: vi.fn(async () => ({ deleted: true as const })),
  get: vi.fn(async () => {
    throw new Error("A mocked diff reads no object");
  }),
  put: vi.fn(async () => ({ storageUri: "storage://patch" })),
});

describe("handleNativeBuildMark", () => {
  const mark = async (
    id: string,
    options: { json?: boolean; clear?: boolean } = {},
  ) => {
    const { handleNativeBuildMark } = await import("./nativeBuild");
    await handleNativeBuildMark(id, options);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({ patch: { enabled: true } });
    loadServer.mockImplementation(async () =>
      testServer({ database: databaseHarness.database, storage }),
    );
    vi.mocked(createBundleDiff).mockImplementation((async ({
      baseBundleId,
    }: {
      baseBundleId: string;
    }) => ({ patches: [{ baseBundleId, byteSize: 2_048 }] })) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("marks a build, in a line or two", async () => {
    await register(6);

    await mark(buildId(6));

    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ store_build: true });
    expect(lines("success")).toEqual([
      expect.stringMatching(/iOS 1\.7\.0 \(66\) is the store build/),
    ]);
    expect(lines("success")[0]!.split("\n").length).toBeLessThanOrEqual(3);
    expect(createBundleDiff).not.toHaveBeenCalled();
  });

  it("says which build it replaced", async () => {
    await register(2);
    await register(6);
    await mark(buildId(2));
    vi.clearAllMocks();

    await mark(buildId(6));

    expect(lines("success")[0]).toMatch(/Replaces iOS 1\.7\.0 \(62\)/);
    await expect(
      databaseHarness.core.getNativeBuild(buildId(2)),
    ).resolves.toMatchObject({ store_build: null });
  });

  it("patches the live OTA from the build, once and no other", async () => {
    await register(6);
    await deployOta(otaId(1));
    await deployOta(otaId(2));
    const findBaseBundleIds = vi.spyOn(
      databaseHarness.core,
      "findBaseBundleIds",
    );

    await mark(buildId(6));

    // One read of the scope's catalog, one patch: never a walk over its OTAs.
    expect(findBaseBundleIds).toHaveBeenCalledOnce();
    expect(findBaseBundleIds.mock.calls[0]![2]).toBe(1);
    expect(createBundleDiff).toHaveBeenCalledOnce();
    expect(vi.mocked(createBundleDiff).mock.calls[0]).toEqual([
      { baseBundleId: builtInId(6), bundleId: otaId(2) },
      expect.objectContaining({
        signingPublicKey: "public-key",
        storageAdapter: storage,
      }),
      { makePrimary: false },
    ]);
    expect(lines("success")[0]).toContain(
      `Patched OTA ${otaId(2).slice(0, 8)}`,
    );
  });

  it("skips an OTA that already patches from the build, as a re-run finds", async () => {
    await register(6);
    await deployOta(otaId(1), {
      patches: [
        {
          baseBundleId: builtInId(6),
          baseFileHash: "base",
          byteSize: 10,
          patchFileHash: "patch",
          patchStorageUri: "storage://patch",
        },
      ],
    });

    await mark(buildId(6));
    await mark(buildId(6));

    expect(createBundleDiff).not.toHaveBeenCalled();
  });

  it("patches an OTA of the build's own scope only", async () => {
    await register(6);
    await deployOta(otaId(1), { targetAppVersion: "2.0.0" });
    await deployOta(otaId(2), { channel: "beta" });

    await mark(buildId(6));

    expect(createBundleDiff).not.toHaveBeenCalled();
  });

  it("patches no OTA older than the build", async () => {
    await deployOta("018f0000-0000-7000-8000-00000000c001");
    await register(6);

    await mark(buildId(6));

    expect(createBundleDiff).not.toHaveBeenCalled();
  });

  it("creates no patch when the project turned patches off", async () => {
    loadConfig.mockResolvedValue({ patch: { enabled: false } });
    await register(6);
    await deployOta(otaId(1));

    await mark(buildId(6));

    expect(createBundleDiff).not.toHaveBeenCalled();
    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ store_build: true });
  });

  it("keeps the mark and warns when the patch fails", async () => {
    await register(6);
    await deployOta(otaId(1));
    vi.mocked(createBundleDiff).mockRejectedValueOnce(
      new Error("storage is down"),
    );

    await mark(buildId(6));

    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ store_build: true });
    expect(lines("warn").join("\n")).toContain("storage is down");
    expect(process.exitCode).toBeUndefined();
  });

  it("clears the mark and touches no patch", async () => {
    await register(6);
    await deployOta(otaId(1));
    await mark(buildId(6));
    vi.clearAllMocks();

    await mark(buildId(6), { clear: true });

    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ store_build: null });
    expect(lines("success")).toEqual([
      expect.stringMatching(/iOS 1\.7\.0 \(66\) isn't the store build/),
    ]);
    expect(createBundleDiff).not.toHaveBeenCalled();
  });

  it("succeeds when run again, for a CI job's retry", async () => {
    await register(6);

    await mark(buildId(6));
    await mark(buildId(6));
    await mark(buildId(6), { clear: true });
    await mark(buildId(6), { clear: true });

    expect(process.exit).not.toHaveBeenCalled();
  });

  it("prints the build, what it replaced and its patch as JSON", async () => {
    await register(2);
    await register(6);
    await mark(buildId(2));
    await deployOta(otaId(1));

    await mark(buildId(6), { json: true });

    expect(output()).toMatchObject({
      nativeBuild: { id: buildId(6), store_build: true },
      previous: { id: buildId(2), store_build: null },
      patch: { bundleId: otaId(1), byteSize: expect.any(Number) },
    });
  });

  it("refuses a sandbox channel's build in a line or two", async () => {
    await register(6, { channel: "sandbox-release" });

    await expect(mark(buildId(6))).rejects.toThrow("process.exit");

    expect(log.error).toHaveBeenCalledOnce();
    expect(lines("error")[0]!.split("\n").length).toBeLessThanOrEqual(2);
    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ store_build: null });
  });

  it("names the next step for a build that isn't registered", async () => {
    await expect(mark(buildId(9))).rejects.toThrow("process.exit");

    expect(lines("error")[0]).toContain("native-build find");
  });
});

describe("deleting a marked build", () => {
  it("says deploys fall back, before asking", async () => {
    vi.clearAllMocks();
    databaseHarness.reset();
    loadConfig.mockResolvedValue({});
    loadServer.mockImplementation(async () =>
      testServer({ database: databaseHarness.database, storage }),
    );
    await register(6);
    await databaseHarness.core.markNativeBuild(buildId(6), {
      storeBuild: true,
    });
    const { handleNativeBuildDelete } = await import("./nativeBuild");
    const stdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });

    try {
      await handleNativeBuildDelete(buildId(6), { yes: true });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: stdinIsTTY,
      });
    }

    expect(lines("step").join("\n")).toContain("store build");
    await expect(
      databaseHarness.core.findNativeBuild(
        {
          platform: "ios",
          channel: CHANNEL,
          fingerprintHash: null,
          appVersion: "1.7.0",
        },
        { storeBuild: true },
      ),
    ).resolves.toBeNull();
  });
});
