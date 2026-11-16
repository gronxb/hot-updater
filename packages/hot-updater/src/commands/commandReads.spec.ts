/**
 * What the CLI's list and lookup commands read, at a small and a large
 * database: a command's reads must not grow with tables it doesn't list.
 * Each case runs the command's own handler on core over a metered memory
 * adapter, and logs both sizes' numbers.
 */
import {
  type Bundle,
  createMemoryAdapter,
  createStorageAdapter,
  type HotUpdaterCoreApi,
  meterReads,
  type ReadMeasurement,
} from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { createReleaseCatalogTestStorage } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testServer } from "../utils/testServer";
import { checkServerData } from "./doctor/serverData";

const { loadConfig, loadServer } = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({})),
  loadServer: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  loadConfig,
}));
vi.mock("@/utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer,
}));
vi.mock("../utils/loadServer", async () => ({
  ...(await vi.importActual<typeof import("../utils/loadServer")>(
    "../utils/loadServer",
  )),
  loadServer,
}));
vi.mock("@/utils/printBanner", () => ({ printBanner: vi.fn() }));
vi.mock("../utils/printBanner", () => ({ printBanner: vi.fn() }));

const id = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const bundleOf = (n: number): Bundle => ({
  id: id(n),
  platform: "ios",
  gitCommitHash: null,
  manifestStorageUri: `storage://bundles/${n}/manifest.json`,
  manifestFileHash: `manifest-hash-${n}`,
  assetBaseStorageUri: "storage://assets",
});

/** Core on a metered memory adapter, as `loadServer` gives the CLI. */
const createMeasured = () => {
  const database = meterReads({
    name: "command-reads",
    adapter: createMemoryAdapter(),
  });
  const { core } = createHotUpdater({
    database,
    storage: createReleaseCatalogTestStorage(),
    clientAccess: "public",
  });
  loadServer.mockResolvedValue(
    testServer({
      database: { ...database, core } as never,
      storage: createStorageAdapter({
        name: "test",
        protocol: "storage",
        delete: async () => ({ deleted: true as const }),
      }),
    }),
  );
  return { core: core as HotUpdaterCoreApi, measure: database.measureReads };
};

interface Size {
  /** Production iOS 1.0.0 releases; only the newest is enabled. */
  readonly releases: number;
  /** Other channels, named pr-1 to pr-N. */
  readonly channels?: number;
  /** A native build on production. */
  readonly nativeBuild?: boolean;
  /** Production iOS fingerprint scopes, one enabled release each. */
  readonly fingerprints?: number;
}

const seed = async (
  core: HotUpdaterCoreApi,
  { releases, channels = 0, nativeBuild = false, fingerprints = 0 }: Size,
) => {
  for (let n = 1; n <= fingerprints; n += 1) {
    await core.deploy([
      {
        bundle: bundleOf(500_000 + n),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: `fingerprint-${n}`,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
  }
  for (let n = 1; n <= releases; n += 1) {
    await core.deploy([
      {
        bundle: bundleOf(n),
        release: {
          channel: "production",
          enabled: n === releases,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.0",
        },
      },
    ]);
  }
  for (let n = 1; n <= channels; n += 1) {
    await core.ensureChannel(`pr-${n}`);
  }
  if (nativeBuild) {
    await core.registerNativeBuild({
      id: id(900_001),
      minBundleId: id(900_002),
      platform: "ios",
      channel: "production",
      fingerprintHash: null,
      appVersion: "1.0.0",
      gitCommitHash: null,
      buildKey: null,
      artifact: {
        kind: "ipa",
        storageUri: "storage://native-builds/App.ipa",
        byteSize: 1,
      },
      embeddedBundle: {
        manifestStorageUri: "storage://bundles/built-in/manifest.json",
        manifestFileHash: "manifest-hash",
        assetBaseStorageUri: "storage://assets",
      },
    } as never);
  }
};

const rows = (measured: ReadMeasurement<unknown>) =>
  measured.adapter.rows + measured.adapter.keys;

/** Runs `read` on a database seeded small and large, and reports both. */
const atTwoSizes = async (
  label: string,
  sizes: readonly [Size, Size],
  read: (core: HotUpdaterCoreApi) => Promise<unknown>,
) => {
  const results = [];
  for (const size of sizes) {
    const { core, measure } = createMeasured();
    await seed(core, size);
    const measured = await measure(async () => {
      try {
        return await read(core);
      } catch (error) {
        // A command that exits ends here, after its reads.
        if ((error as Error).message !== "process.exit") throw error;
        return undefined;
      }
    });
    results.push({ ...size, ...measured.adapter, rows: rows(measured) });
  }
  process.stderr.write(`${label} ${JSON.stringify(results)}\n`);
  return results as [(typeof results)[0], (typeof results)[0]];
};

const TEN_VS_THOUSAND_CHANNELS = [
  { releases: 5, channels: 10, nativeBuild: true },
  { releases: 5, channels: 1_000, nativeBuild: true },
] as const;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel lookups read the channels they name", () => {
  it("bundle list -c production -p ios --limit 1 --json, as the actions' deployBundle runs it", async () => {
    const { handleBundleList } = await import("./bundle");
    const [small, large] = await atTwoSizes(
      "deployBundle",
      TEN_VS_THOUSAND_CHANNELS,
      () =>
        handleBundleList({
          channel: "production",
          platform: "ios",
          limit: 1,
          json: true,
        }),
    );
    expect(large.rows).toBe(small.rows);
    // The channel by name, then the newest release of its iOS index.
    expect(large.rows).toBeLessThanOrEqual(2);
  }, 120_000);

  it("bundle list --channel production, as a table", async () => {
    const { handleBundleList } = await import("./bundle");
    const [small, large] = await atTwoSizes(
      "release list --channel",
      TEN_VS_THOUSAND_CHANNELS,
      () => handleBundleList({ channel: "production" }),
    );
    expect(large.rows).toBe(small.rows);
  }, 120_000);

  it("bundle show", async () => {
    const { handleBundleShow } = await import("./bundle");
    const [small, large] = await atTwoSizes(
      "release show",
      TEN_VS_THOUSAND_CHANNELS,
      () => handleBundleShow(id(5)),
    );
    expect(large.rows).toBe(small.rows);
  }, 120_000);

  it("promote", async () => {
    const { handlePromote } = await import("./promote");
    const [small, large] = await atTwoSizes(
      "promote",
      TEN_VS_THOUSAND_CHANNELS,
      async (core) => {
        const [release] = await core.listReleases({
          filter: { kind: "all" },
          limit: 1,
          order: "desc",
        });
        await handlePromote(release!.id, { target: "beta", yes: true });
        expect(await core.findChannelByName("beta")).not.toBeNull();
      },
    );
    expect(large.rows).toBe(small.rows);
  }, 120_000);

  it("native-build delete", async () => {
    const { handleNativeBuildDelete } = await import("./nativeBuild");
    const [small, large] = await atTwoSizes(
      "native-build delete",
      TEN_VS_THOUSAND_CHANNELS,
      async (core) => {
        await handleNativeBuildDelete(id(900_001), { json: true, yes: true });
        // The build was there to delete.
        expect(await core.getNativeBuild(id(900_001))).toBeNull();
        expect(vi.mocked(console.log)).toHaveBeenLastCalledWith(
          expect.stringContaining('"deleted": true'),
        );
      },
    );
    expect(large.rows).toBe(small.rows);
  }, 120_000);
});

describe("filters no index serves stop after a few pages", () => {
  const scanned = () =>
    vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");

  it("bundle list --target-app-version", async () => {
    const { handleBundleList } = await import("./bundle");
    const [small, large] = await atTwoSizes(
      "release list --target-app-version",
      [{ releases: 50 }, { releases: 2_000 }],
      () => handleBundleList({ targetAppVersion: "9.9.9", json: true }),
    );
    expect(small.rows).toBe(50);
    expect(large.rows).toBe(500);
    expect(scanned()).toMatch(
      /^Scanned 500 bundles\. Narrow with --channel, or continue with --cursor [0-9a-f-]{36}$/m,
    );
  }, 120_000);

  it("continues with --cursor where a stopped scan ended", async () => {
    const { handleBundleList } = await import("./bundle");
    const { core } = createMeasured();
    // The oldest of 600 bundles is the one 9.9.9 bundle.
    for (let n = 1; n <= 600; n += 1) {
      await core.deploy([
        {
          bundle: bundleOf(n),
          release: {
            channel: "production",
            enabled: false,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: n === 1 ? "9.9.9" : "1.0.0",
          },
        },
      ]);
    }
    const listed = () =>
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

    await handleBundleList({ targetAppVersion: "9.9.9", json: true });
    expect(listed()).toEqual([]);
    const cursor = /--cursor (\S+)$/m.exec(scanned())![1]!;
    const newest = await core.listReleases({
      filter: { kind: "all" },
      limit: 500,
      order: "desc",
    });
    expect(cursor).toBe(newest.at(-1)!.id);

    vi.mocked(console.error).mockClear();
    await handleBundleList({ targetAppVersion: "9.9.9", json: true, cursor });
    expect(listed()).toMatchObject([
      { bundle_id: id(1), target_app_version: "9.9.9" },
    ]);
    expect(scanned()).toBe("");
  }, 120_000);

  it("lists a match that is the last bundle a stopped scan read", async () => {
    const { handleBundleList } = await import("./bundle");
    const { core } = createMeasured();
    // Of 600 bundles, only the 500th newest is 9.9.9: the scan's last row.
    for (let n = 1; n <= 600; n += 1) {
      await core.deploy([
        {
          bundle: bundleOf(n),
          release: {
            channel: "production",
            enabled: false,
            fingerprintHash: null,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: n === 101 ? "9.9.9" : "1.0.0",
          },
        },
      ]);
    }
    const listed = () =>
      JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

    await handleBundleList({ targetAppVersion: "9.9.9", json: true });
    expect(listed()).toMatchObject([
      { bundle_id: id(101), target_app_version: "9.9.9" },
    ]);
    const cursor = /--cursor (\S+)$/m.exec(scanned())![1]!;

    vi.mocked(console.error).mockClear();
    await handleBundleList({ targetAppVersion: "9.9.9", json: true, cursor });
    expect(listed()).toEqual([]);
  }, 120_000);

  it("bundle list --platform android, with only iOS bundles", async () => {
    const { handleBundleList } = await import("./bundle");
    const [small, large] = await atTwoSizes(
      "release list --platform",
      [{ releases: 50 }, { releases: 2_000 }],
      () => handleBundleList({ platform: "android", json: true }),
    );
    expect(small.rows).toBe(50);
    expect(large.rows).toBe(500);
    expect(scanned()).toMatch(/^Scanned 500 bundles\./m);
  }, 120_000);
});

describe("doctor's catalog check", () => {
  it("reads no more with 2,000 releases than with 50", async () => {
    const [small, large] = await atTwoSizes(
      "doctor, releases",
      [{ releases: 50 }, { releases: 2_000 }],
      (core) => checkServerData(core),
    );
    expect(large.rows).toBe(small.rows);
  }, 120_000);

  it("reads no more with 1,000 channels than with 10", async () => {
    const [small, large] = await atTwoSizes(
      "doctor, channels",
      [
        { releases: 5, channels: 10 },
        { releases: 5, channels: 1_000 },
      ],
      (core) => checkServerData(core),
    );
    expect(large.rows).toBe(small.rows);
    expect(large.queries).toBe(small.queries);
  }, 120_000);

  it("reads 8 rows per scope", async () => {
    const [small, large] = await atTwoSizes(
      "doctor, scopes",
      [
        { releases: 50, fingerprints: 10 },
        { releases: 50, fingerprints: 200 },
      ],
      (core) => checkServerData(core),
    );
    // Each scope: one row for the seek past it, and 7 to compare its
    // catalog with a rebuild from its enabled release.
    expect(large.rows - small.rows).toBe(190 * 8);
  }, 120_000);
});
