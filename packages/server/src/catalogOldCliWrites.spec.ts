import { createMemoryAdapter } from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import { createStandaloneCoreApi as createReleasedStandaloneCoreApi } from "@hot-updater/standalone-1.1.16";
import {
  createBundleFixture,
  setReleaseCatalogPartitioning,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "./core/inProcess.testFixtures";
import { createHotUpdaterHandlers } from "./handler";

const SCOPE = createReleaseCatalogScopeKey({
  channelKey: encodeChannelKey("production"),
  platform: "ios",
  strategy: "APP_VERSION",
});

type ReleasedCore = ReturnType<typeof createReleasedStandaloneCoreApi>;

/**
 * What the published `hot-updater@1.1.16` CLI does with a write's result,
 * copied from its `dist/index.mjs`:
 * - `deploy` matches each commit to its release by `commit.catalog.scope_key`
 *   and refuses one whose `commit.catalog.platform` differs from the
 *   bundle's (lines 48158 and 48168);
 * - `release update --dry-run` prints the preflight's
 *   `currentCatalog?.byte_size`, `diagnostics` and `catalog.generation`
 *   (`printUpdatePreview`, lines 49463–49472);
 * - doctor reads a rebuild preflight's `changed` and
 *   `currentCatalog?.generation` (line 50557).
 * Nothing else of these results is read: never a catalog's payload.
 */
const cliDeploy = async (core: ReleasedCore, suffix: string, range: string) => {
  const commits = await core.deploy([
    {
      bundle: { ...createBundleFixture(suffix), platform: "ios" },
      release: {
        channel: "production",
        enabled: true,
        fingerprintHash: null,
        message: null,
        shouldForceUpdate: false,
        targetAppVersion: range,
      },
    },
  ]);
  for (const commit of commits) {
    if (commit.catalog.scope_key !== commit.release!.scope_key) {
      throw new Error("Deployment commit does not match its release");
    }
    if (commit.catalog.platform !== "ios") {
      throw new Error("Deployment commit platform does not match");
    }
  }
  return commits[0]!.release!.id;
};

const printUpdatePreview = (
  result: Awaited<ReturnType<ReleasedCore["preflightReleasePolicy"]>>,
) =>
  [
    ["Current bytes", String(result.currentCatalog?.byte_size ?? 0)],
    ["Projected bytes", String(result.diagnostics.byteSize)],
    ["Maximum bytes", String(262144)],
    ["Descriptors", String(result.diagnostics.descriptorCount)],
    ["Intervals", String(result.diagnostics.segmentCount)],
    ["Named cohorts", String(result.diagnostics.distinctTargetCohortCount)],
    ["Next generation", String(result.catalog.generation)],
  ]
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

/** One server, compact or partitioned, and the 1.1.16 client a CLI runs over it. */
const serverOf = async (partitioned: boolean) => {
  const memory = createMemoryAdapter();
  const core = createInProcessCoreApi(memory);
  if (partitioned) await setReleaseCatalogPartitioning(memory, "on");
  const server = await startHttpTestServer(
    createHotUpdaterHandlers({ api: { core } }),
  );
  return {
    client: createReleasedStandaloneCoreApi({
      baseUrl: `${server.baseUrl}/admin`,
    }),
    close: () => server.close(),
    stored: () => memory,
  };
};

/** The CLI session both servers receive, and everything it prints or reads. */
const session = async (client: ReleasedCore) => {
  const output: string[] = [];
  const ids: string[] = [];
  for (const [suffix, range] of [
    ["101", "1.0.0"],
    ["102", ">=1.0.0 <2.0.0"],
    ["103", "2.0.0"],
    ["104", "*"],
  ] as const) {
    ids.push(await cliDeploy(client, suffix, range));
  }
  output.push(
    printUpdatePreview(
      await client.preflightReleasePolicy({
        patch: { targetAppVersion: "1.x" },
        releaseId: ids[1]!,
      }),
    ),
  );
  const updated = await client.updateReleasePolicy({
    patch: { targetAppVersion: "1.x" },
    releaseId: ids[1]!,
  });
  output.push(`updated generation ${updated.catalog.generation}`);
  output.push(
    printUpdatePreview(
      await client.preflightReleasePolicy({
        patch: { enabled: false },
        releaseId: ids[3]!,
      }),
    ),
  );
  const doctor = await client.preflightReleaseCatalogRebuild(SCOPE);
  output.push(
    `doctor ${doctor.changed ? "stale" : "verified"} ${doctor.currentCatalog?.generation}`,
  );
  const rebuilt = await client.rebuildReleaseCatalog(SCOPE);
  output.push(`rebuild ${rebuilt.changed} ${rebuilt.catalog.generation}`);
  return output;
};

describe("released 1.1.16 CLI writes against a partitioned server", () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterAll(async () => {
    for (const server of servers) await server.close();
  });

  it("prints and checks the same for a partitioned scope as for a compact one", async () => {
    const compact = await serverOf(false);
    const partitioned = await serverOf(true);
    servers.push(compact, partitioned);
    const expected = await session(compact.client);
    const actual = await session(partitioned.client);
    expect(actual).toEqual(expected);
    // The partitioned server really stored the scope partitioned.
    const row = await partitioned.client.getReleaseCatalogRow(SCOPE);
    expect(row!.payload).not.toContain('"layout"');
    const [head] = await partitioned
      .stored()
      .query(
        (
          await import("@hot-updater/plugin-core")
        ).coreTarget.schema.tables.find(
          ({ name }) => name === "release_catalogs",
        )!,
        { index: "all", eq: [], order: "asc", limit: 1 },
      );
    expect(String(head!.payload)).toContain('"layout":"partitioned"');
  });
});
