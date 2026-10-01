import { loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import { createEngine } from "@hot-updater/plugin-core";
import { storeBundles } from "@hot-updater/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadServer } from "../utils/loadServer";
import { testServer } from "../utils/testServer";
import { createDatabaseHarness } from "./database.testFixtures";
import { doctor, handleDoctor } from "./doctor";

vi.mock("../packageJson", () => ({ packageJsonData: { version: "1.0.0" } }));

vi.mock("../utils/loadServer", () => ({ loadServer: vi.fn() }));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(() => "/project"),
  loadConfig: vi.fn(),
  readPackageUp: vi.fn(),
}));

const harness = createDatabaseHarness();

/** A server project without React Native: doctor checks only its catalogs. */
const serverProject = () => {
  vi.mocked(readPackageUp).mockResolvedValue({
    packageJson: { dependencies: { "hot-updater": "1.0.0" } },
    path: "/project/package.json",
  } as never);
  vi.mocked(loadConfig).mockResolvedValue({
    server: "/project/hotUpdater.ts",
  } as never);
  vi.mocked(loadServer).mockImplementation(async () =>
    testServer({ database: harness.database }),
  );
};

const bundle = (index: number, platform: "ios" | "android" = "ios") => ({
  assetBaseStorageUri: "storage://assets",
  gitCommitHash: null,
  id: `01900000-0000-7000-8000-${String(index).padStart(12, "0")}`,
  manifestFileHash: `manifest-hash-${index}`,
  manifestStorageUri: `storage://artifacts/${index}/manifest.json`,
  metadata: {},
  platform,
});

/** Deploys one release, whose scope gets a catalog. */
const deploy = async (
  index = 1,
  { platform = "ios" }: { readonly platform?: "ios" | "android" } = {},
) => {
  const [result] = await harness.core.deploy([
    {
      bundle: bundle(index, platform),
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion: "1.0.x",
      },
    },
  ]);
  return result!.release!.scope_key;
};

/** Deletes a scope's catalog row, leaving its releases. */
const loseCatalogRow = async (scopeKey: string) => {
  const engine = createEngine(harness.database);
  try {
    await engine.core.transaction(async (tx) => {
      const row = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      await tx.delete("release_catalogs", row!);
    });
  } finally {
    await engine.dispose();
  }
};

/** Makes a scope's stored catalog differ from what its releases compile to. */
const makeStale = async (scopeKey: string) => {
  const engine = createEngine(harness.database);
  try {
    await engine.core.transaction(async (tx) => {
      const row = await tx.findOne("release_catalogs", {
        scope_key: scopeKey,
      });
      tx.update("release_catalogs", row!, {
        catalog_hash: `sha256:${"0".repeat(64)}`,
      });
    });
  } finally {
    await engine.dispose();
  }
};

describe("doctor's release catalog check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.reset();
    serverProject();
  });

  it("skips the check when hot-updater.config.ts names no server", async () => {
    vi.mocked(loadConfig).mockResolvedValue({} as never);

    await expect(doctor()).resolves.toBe(true);
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("warns, without failing, when it cannot reach the server's database", async () => {
    vi.mocked(loadServer).mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          scopes: [],
          issues: [
            {
              type: "warning",
              code: "RELEASE_CATALOGS_UNCHECKED",
              message: expect.stringContaining("ECONNREFUSED"),
              resolution: expect.stringContaining("server"),
              fixability: "blocked",
            },
          ],
        },
      },
    });
  });

  it("verifies each scope's catalog against its releases", async () => {
    const scopeKey = await deploy();

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "verified", generation: 1 }],
          issues: [],
        },
      },
    });
  });

  it("reports a catalog that differs from its releases, and --json exits non-zero", async () => {
    const scopeKey = await deploy();
    await makeStale(scopeKey);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await handleDoctor({ json: true }).catch(() => {});

    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "stale" }],
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_STALE",
              scopeKey,
              fixability: "command",
              commands: ["npx hot-updater doctor --fix"],
            },
          ],
        },
      },
    });
  });

  it("rebuilds a stale catalog with --fix, names it, and checks again", async () => {
    const scopeKey = await deploy();
    await makeStale(scopeKey);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleDoctor({ json: true, fix: true });

    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({
      success: true,
      details: {
        fixes: [
          {
            repair: "release-catalogs",
            codes: ["RELEASE_CATALOG_STALE"],
            status: "applied",
            wrote: [`release catalog ${scopeKey}, generation 2`],
            native: false,
          },
        ],
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "verified", generation: 2 }],
          issues: [],
        },
      },
    });
    await expect(
      harness.core.preflightReleaseCatalogRebuild(scopeKey),
    ).resolves.toMatchObject({ changed: false });
  });

  it("reports a scope core cannot compile by itself, and keeps what the other scopes found", async () => {
    const stale = await deploy(1);
    const broken = await deploy(2, { platform: "android" });
    await makeStale(stale);
    vi.mocked(loadServer).mockImplementation(async () =>
      testServer({
        database: {
          ...harness.database,
          core: {
            ...harness.core,
            preflightReleaseCatalogRebuild: async (scopeKey: string) => {
              if (scopeKey === broken) throw new Error("payload is corrupt");
              return harness.core.preflightReleaseCatalogRebuild(scopeKey);
            },
          },
        } as never,
      }),
    );

    const result = await doctor();

    expect(result).toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: expect.arrayContaining([
            expect.objectContaining({ scopeKey: stale, state: "stale" }),
            expect.objectContaining({ scopeKey: broken, state: "unchecked" }),
          ]),
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "RELEASE_CATALOG_STALE",
              scopeKey: stale,
            }),
            expect.objectContaining({
              type: "error",
              code: "RELEASE_CATALOG_CHECK_FAILED",
              scopeKey: broken,
              message: expect.stringContaining("payload is corrupt"),
            }),
          ]),
        },
      },
    });
    expect(
      (result as { details: { releaseCatalogs: { issues: unknown[] } } })
        .details.releaseCatalogs.issues,
    ).toHaveLength(2);
  });

  it("finds a scope whose releases have no catalog row, and leaves it to a backup restore under --fix", async () => {
    const scopeKey = await deploy();
    await loseCatalogRow(scopeKey);

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: false,
      details: {
        fixes: [],
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "missing", generation: null }],
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
              fixability: "blocked",
            },
          ],
        },
      },
    });
  });

  it("warns about artifact records no release uses, and --fix deletes them", async () => {
    const orphan = bundle(9);
    await deploy();
    await storeBundles(harness.database, [orphan]);

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        artifacts: {
          unreferenced: [orphan.id],
          issues: [
            {
              type: "warning",
              code: "UNREFERENCED_ARTIFACTS",
              artifactIds: [orphan.id],
              commands: ["npx hot-updater doctor --fix"],
            },
          ],
        },
      },
    });

    await expect(doctor({ fix: true })).resolves.toMatchObject({
      success: true,
      details: {
        fixes: [
          {
            repair: "unreferenced-artifacts",
            status: "applied",
            wrote: [`artifact record ${orphan.id}`],
            native: false,
          },
        ],
        artifacts: { unreferenced: [], issues: [] },
      },
    });
    await expect(harness.core.getBundle(orphan.id)).resolves.toBeNull();
    expect(loadServer).toHaveBeenCalledTimes(2);
  });
});
