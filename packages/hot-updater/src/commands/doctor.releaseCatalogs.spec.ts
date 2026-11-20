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
    database: harness.database,
    plugins: [],
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
  {
    platform = "ios",
    message = null,
  }: {
    readonly platform?: "ios" | "android";
    readonly message?: string | null;
  } = {},
) => {
  const [result] = await harness.core.deploy([
    {
      bundle: bundle(index, platform),
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message,
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
  await engine.core.transaction(async (tx) => {
    const row = await tx.findOne("release_catalogs", {
      scope_key: scopeKey,
    });
    await tx.delete("release_catalogs", row!);
  });
};

/** Makes a scope's stored catalog differ from what its releases compile to. */
const makeStale = async (scopeKey: string) => {
  const engine = createEngine(harness.database);
  await engine.core.transaction(async (tx) => {
    const row = await tx.findOne("release_catalogs", {
      scope_key: scopeKey,
    });
    tx.update("release_catalogs", row!, {
      catalog_hash: `sha256:${"0".repeat(64)}`,
    });
  });
};

/** Takes every release's label and every counter off, as a 1.1 database holds them. */
const asBeforeLabels = async () => {
  const engine = createEngine(harness.database);
  const { rows } = await engine.core.findMany("releases", {
    index: "all",
    where: {},
    limit: 100,
  });
  const { rows: counters } = await engine.core.findMany("label_sequences", {
    index: "all",
    where: {},
    limit: 100,
  });
  await engine.core.transaction(async (tx) => {
    for (const { id } of rows) {
      const row = await tx.findOne("releases", { id });
      tx.update("releases", row!, { label: null });
    }
    for (const { id } of counters) {
      const counter = await tx.findOne("label_sequences", { id });
      await tx.delete("label_sequences", counter!);
    }
  });
};

describe("doctor's release catalog check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.reset();
    serverProject();
  });

  it("skips the check when hot-updater.config.ts names no database", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ plugins: [] } as never);

    const result = await doctor();
    expect(result).toMatchObject({ success: true });
    expect(result).not.toHaveProperty("details.releaseCatalogs");
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
              resolution:
                "Check that database in hot-updater.config.ts is reachable from here, then rerun doctor.",
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

  it("warns once a scope's catalog reaches 80% of its size limit, and not before", async () => {
    // 60 KB messages: three compile to under 80% of 256 KiB, four to over it.
    const message = "m".repeat(60_000);
    for (let index = 1; index <= 3; index += 1) {
      await deploy(index, { message });
    }
    const under = await doctor();
    expect(under).toMatchObject({
      success: true,
      details: { releaseCatalogs: { issues: [] } },
    });
    expect(
      (
        under as {
          details: { releaseCatalogs: { scopes: { byteSize: number }[] } };
        }
      ).details.releaseCatalogs.scopes[0]!.byteSize,
    ).toBeLessThan(0.8 * 256 * 1024);

    const scopeKey = await deploy(4, { message });
    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "verified" }],
          issues: [
            {
              type: "warning",
              code: "RELEASE_CATALOG_NEAR_LIMIT",
              scopeKey,
              message: expect.stringMatching(
                /^The ios release catalog of channel "production" is \d+% of its 256 KiB limit\.$/u,
              ),
              resolution:
                "Disable or delete old bundles on that channel before a deploy to it fails.",
            },
          ],
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
              resolution: expect.stringContaining(
                "Every release change in the scope recompiles its catalog",
              ),
              commands: [
                "npx hot-updater deploy",
                "npx hot-updater bundle update <id>",
              ],
            },
          ],
        },
      },
    });
  });

  it("reports releases without labels and catalogs without them, names the command that migrates, and nothing once it ran", async () => {
    const ios = await deploy(1);
    const android = await deploy(2, { platform: "android" });
    await asBeforeLabels();
    // Catalogs compiled while the releases had none, then a fill of the
    // releases alone: the catalogs now lack their labels.
    await harness.core.rebuildReleaseCatalog(ios);
    await harness.core.rebuildReleaseCatalog(android);
    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          issues: [
            {
              type: "warning",
              code: "RELEASE_LABELS_MISSING",
              message: "2 releases have no label.",
              commands: ["npx hot-updater db migrate <server file>"],
            },
          ],
        },
      },
    });
    await harness.core.fillReleaseLabels({ catalogs: false });
    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          scopes: [
            { scopeKey: android, state: "stale" },
            { scopeKey: ios, state: "stale" },
          ],
          issues: [
            {
              type: "warning",
              code: "RELEASE_CATALOGS_WITHOUT_LABELS",
              message:
                "2 release catalogs lack the labels of their releases, so apps don't get them.",
              commands: ["npx hot-updater db migrate <server file>"],
            },
          ],
        },
      },
    });

    // What `db migrate` and init run once the schema is migrated.
    await harness.core.fillReleaseLabels();

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
        releaseCatalogs: {
          scopes: [
            { scopeKey: android, state: "verified" },
            { scopeKey: ios, state: "verified" },
          ],
          issues: [],
        },
      },
    });
  });

  it("verifies a stale catalog once a deploy to its scope recompiles it", async () => {
    const scopeKey = await deploy();
    await makeStale(scopeKey);

    // What the resolution names: the scope's next release change.
    await expect(deploy(2)).resolves.toBe(scopeKey);

    await expect(doctor()).resolves.toMatchObject({
      success: true,
      details: {
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

  it("finds the newest fingerprint scope of a channel's platform without its catalog row", async () => {
    await deploy(1);
    // Release IDs are UUIDv7s: a later millisecond makes this one newest.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [fingerprinted] = await harness.core.deploy([
      {
        bundle: bundle(2),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: "fingerprint-2",
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
    const scopeKey = fingerprinted!.release!.scope_key;
    await loseCatalogRow(scopeKey);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: expect.arrayContaining([
            expect.objectContaining({ scopeKey, state: "missing" }),
          ]),
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
            },
          ],
        },
      },
    });
  });

  it("finds a channel's app-version scope without its catalog row behind a newer fingerprint release", async () => {
    const scopeKey = await deploy(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.core.deploy([
      {
        bundle: bundle(2),
        release: {
          channel: "production",
          enabled: true,
          fingerprintHash: "fingerprint-2",
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: null,
        },
      },
    ]);
    await loseCatalogRow(scopeKey);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: expect.arrayContaining([
            expect.objectContaining({ scopeKey, state: "missing" }),
          ]),
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
            },
          ],
        },
      },
    });
  });

  it("finds an older fingerprint scope without its catalog row behind newer releases", async () => {
    const fingerprint = (index: number, hash: string) =>
      harness.core.deploy([
        {
          bundle: bundle(index),
          release: {
            channel: "production",
            enabled: true,
            fingerprintHash: hash,
            message: null,
            shouldForceUpdate: false,
            targetAppVersion: null,
          },
        },
      ]);
    await deploy(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [older] = await fingerprint(2, "fingerprint-a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fingerprint(3, "fingerprint-b");
    const scopeKey = older!.release!.scope_key;
    await loseCatalogRow(scopeKey);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: expect.arrayContaining([
            expect.objectContaining({ scopeKey, state: "missing" }),
          ]),
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
            },
          ],
        },
      },
    });
  });

  it("finds a scope whose releases have no catalog row, and leaves it to a backup restore", async () => {
    const scopeKey = await deploy();
    await loseCatalogRow(scopeKey);

    await expect(doctor()).resolves.toMatchObject({
      success: false,
      details: {
        releaseCatalogs: {
          scopes: [{ scopeKey, state: "missing", generation: null }],
          issues: [
            {
              type: "error",
              code: "RELEASE_CATALOG_IDENTITY_MISSING",
              scopeKey,
            },
          ],
        },
      },
    });
  });
});
