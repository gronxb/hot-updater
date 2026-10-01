import { loadConfig, readPackageUp } from "@hot-updater/cli-tools";
import { createEngine } from "@hot-updater/plugin-core";
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

/** Deploys one release, whose scope gets a catalog. */
const deploy = async () => {
  const [result] = await harness.core.deploy([
    {
      bundle: {
        assetBaseStorageUri: "storage://assets",
        gitCommitHash: null,
        id: "01900000-0000-7000-8000-000000000001",
        manifestFileHash: "manifest-hash",
        manifestStorageUri: "storage://artifacts/1/manifest.json",
        metadata: {},
        platform: "ios",
      },
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

    await expect(doctor()).resolves.toEqual({
      success: true,
      details: expect.objectContaining({
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
      }),
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
});
