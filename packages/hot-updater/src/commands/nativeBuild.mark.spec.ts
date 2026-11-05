import {
  type Bundle,
  createStorageAdapter,
  type NativeBuildRegistration,
} from "@hot-updater/plugin-core";
import { createBundleFixture } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  loadConfig,
  p: { isCancel: () => false, log },
}));
vi.mock("../utils/loadServer", () => ({ loadServer }));
vi.mock("@/utils/loadServer", () => ({ loadServer }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

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
    rolloutCohortCount = 1000,
    targetAppVersion = "1.7.0",
  }: {
    readonly channel?: string;
    readonly patches?: NonNullable<Bundle["patches"]>;
    readonly rolloutCohortCount?: number;
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
        rolloutCohortCount,
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
    ).resolves.toMatchObject({ is_store_build: true });
    expect(lines("success")).toEqual([
      expect.stringMatching(/iOS 1\.7\.0 \(66\) is the store build/),
    ]);
    expect(lines("success")[0]!.split("\n").length).toBeLessThanOrEqual(3);
    expect(lines("warn")).toEqual([]);
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
    ).resolves.toMatchObject({ is_store_build: false });
  });

  const command = (bundleId: string, channel = CHANNEL) =>
    `npx hot-updater patch -p ios -c ${channel} -b ${bundleId} --base-artifact-id ${builtInId(6)}`;
  const patchesOf = async (bundleId: string) =>
    (await databaseHarness.core.getBundle(bundleId))?.patches ?? [];

  it("names the patch the OTA a fresh install gets is missing, and changes no OTA", async () => {
    await register(6);
    await deployOta(otaId(1));
    await deployOta(otaId(2));
    const reads = {
      catalog: vi.spyOn(databaseHarness.core, "getReleaseCatalogRow"),
      bundle: vi.spyOn(databaseHarness.core, "getBundle"),
      bases: vi.spyOn(databaseHarness.core, "findBaseBundleIds"),
      update: vi.spyOn(databaseHarness.core, "updateBundle"),
    };

    await mark(buildId(6));

    expect(lines("warn")).toEqual([
      `OTA ${otaId(2).slice(0, 8)} has no patch from it, so fresh installs download all of it.\n${command(otaId(2))}`,
    ]);
    // Two reads: the scope's catalog and the OTA. No write but the mark.
    expect(reads.catalog).toHaveBeenCalledOnce();
    expect(reads.bundle).toHaveBeenCalledOnce();
    expect(reads.bases).not.toHaveBeenCalled();
    expect(reads.update).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    await expect(patchesOf(otaId(2))).resolves.toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("passes over a newer OTA no install gets", async () => {
    await register(6);
    await deployOta(otaId(1));
    await deployOta(otaId(2), { rolloutCohortCount: 0 });

    await mark(buildId(6));

    expect(lines("warn").join("\n")).toContain(command(otaId(1)));
  });

  it("names the OTA a two-part version's install is served, not a later patch version's", async () => {
    await register(6, { appVersion: "1.7" });
    await deployOta(otaId(1), { targetAppVersion: "1.7.0" });
    await deployOta(otaId(2), { targetAppVersion: "1.7.1" });

    await mark(buildId(6));

    expect(lines("warn").join("\n")).toContain(command(otaId(1)));
  });

  it("quotes a channel the shell would split", async () => {
    const channel = "qa team;x";
    await register(6, { channel });
    await deployOta(otaId(1), { channel });

    await mark(buildId(6));

    expect(lines("warn").join("\n")).toContain(
      command(otaId(1), `'qa team;x'`),
    );
  });

  it("names nothing when the OTA already patches from the build", async () => {
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

    expect(lines("warn")).toEqual([]);
  });

  it("names nothing for an OTA of another scope, or one older than the build", async () => {
    await deployOta("018f0000-0000-7000-8000-00000000c001");
    await register(6);
    await deployOta(otaId(1), { targetAppVersion: "2.0.0" });
    await deployOta(otaId(2), { channel: "beta" });

    await mark(buildId(6));

    expect(lines("warn")).toEqual([]);
  });

  it("names nothing when the project turned patches off", async () => {
    loadConfig.mockResolvedValue({ patch: { enabled: false } });
    await register(6);
    await deployOta(otaId(1));

    await mark(buildId(6));

    expect(lines("warn")).toEqual([]);
    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ is_store_build: true });
  });

  it("clears the mark and names nothing", async () => {
    await register(6);
    await deployOta(otaId(1));
    await mark(buildId(6));
    vi.clearAllMocks();

    await mark(buildId(6), { clear: true });

    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ is_store_build: false });
    expect(lines("success")).toEqual([
      expect.stringMatching(/iOS 1\.7\.0 \(66\) isn't the store build/),
    ]);
    expect(lines("warn")).toEqual([]);
  });

  it("succeeds when run again, for a CI job's retry", async () => {
    await register(6);

    await mark(buildId(6));
    await mark(buildId(6));
    await mark(buildId(6), { clear: true });
    await mark(buildId(6), { clear: true });

    expect(process.exit).not.toHaveBeenCalled();
  });

  it("prints the build, what it replaced and the missing patch as JSON", async () => {
    await register(2);
    await register(6);
    await mark(buildId(2));
    await deployOta(otaId(1));

    await mark(buildId(6), { json: true });

    expect(output()).toMatchObject({
      nativeBuild: { id: buildId(6), is_store_build: true },
      previous: { id: buildId(2), is_store_build: false },
      missingPatch: { bundleId: otaId(1), command: command(otaId(1)) },
    });
  });

  it("refuses a sandbox build in a line or two", async () => {
    await register(6, { channel: "sandbox-release", isSandbox: true });

    await expect(mark(buildId(6))).rejects.toThrow("process.exit");

    expect(log.error).toHaveBeenCalledOnce();
    expect(lines("error")[0]!.split("\n").length).toBeLessThanOrEqual(2);
    await expect(
      databaseHarness.core.getNativeBuild(buildId(6)),
    ).resolves.toMatchObject({ is_store_build: false });
  });

  it("names the next step for a build that isn't registered", async () => {
    await expect(mark(buildId(9))).rejects.toThrow("process.exit");

    expect(lines("error")[0]).toContain("native-build find");
  });

  it("prints JSON a CI job can parse for a build that isn't registered", async () => {
    await expect(mark(buildId(9), { json: true })).rejects.toThrow(
      "process.exit",
    );

    expect(vi.mocked(console.log)).toHaveBeenCalledOnce();
    expect(output()).toEqual({
      id: buildId(9),
      marked: false,
      reason: "not_found",
    });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      "native-build find",
    );
  });

  it("prints JSON for a clear of a build that isn't registered", async () => {
    await expect(mark(buildId(9), { clear: true, json: true })).rejects.toThrow(
      "process.exit",
    );

    expect(output()).toEqual({
      id: buildId(9),
      cleared: false,
      reason: "not_found",
    });
  });

  it("prints JSON for a sandbox build it refuses", async () => {
    await register(6, { channel: "sandbox-release", isSandbox: true });

    await expect(mark(buildId(6), { json: true })).rejects.toThrow(
      "process.exit",
    );

    expect(output()).toEqual({
      id: buildId(6),
      marked: false,
      reason: "sandbox_build",
    });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      "sandbox",
    );
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
