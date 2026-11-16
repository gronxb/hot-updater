import {
  assembleReleaseCatalog,
  compileReleaseCatalogTiling,
  createMemoryAdapter,
  targetBaseCandidateKey,
} from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
  type Release,
} from "@hot-updater/protocol";
import { createStandaloneCoreApi as createReleasedStandaloneCoreApi } from "@hot-updater/standalone-1.1.16";
import {
  createBundleFixture,
  createReleaseCatalogPartitionFixture,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInProcessCoreApi } from "./core/inProcess.testFixtures";
import { createHotUpdaterHandlers } from "./handler";

const scopeKeyOf = (channel: string) =>
  createReleaseCatalogScopeKey({
    channelKey: encodeChannelKey(channel),
    platform: "ios",
    strategy: "APP_VERSION",
  });

/**
 * A released 1.1.16 CLI reads catalogs over this server's admin API through
 * the published `@hot-updater/standalone@1.1.16` client, the real artifact
 * npm serves. Every call it makes answers the same shapes and bytes before
 * and after its scopes are partitioned.
 */
describe("released 1.1.16 standalone client against partitioned catalogs", () => {
  const memory = createMemoryAdapter();
  const core = createInProcessCoreApi(memory);
  const fixture = createReleaseCatalogPartitionFixture(memory);
  let server: Awaited<ReturnType<typeof startHttpTestServer>>;
  let released: ReturnType<typeof createReleasedStandaloneCoreApi>;

  beforeAll(async () => {
    let suffix = 100;
    for (const [channel, ranges] of [
      ["production", ["1.0.0", "1.0.0", ">=1.1.0 <2.0.0", "2.0.0", "1.x"]],
      ["beta", ["3.0.0", "4.0.0"]],
      ["canary", ["*"]],
    ] as const) {
      for (const targetAppVersion of ranges) {
        suffix += 1;
        await core.deploy([
          {
            bundle: createBundleFixture(String(suffix)),
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
      }
    }
    server = await startHttpTestServer(
      createHotUpdaterHandlers({ api: { core } }),
    );
    released = createReleasedStandaloneCoreApi({
      baseUrl: `${server.baseUrl}/admin`,
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  it("gets, lists and finds patch bases exactly as before the scopes were partitioned", async () => {
    const calls = async () => ({
      get: await Promise.all(
        ["production", "beta", "canary", "missing"].map((channel) =>
          released.getReleaseCatalogRow(scopeKeyOf(channel)),
        ),
      ),
      listAsc: await released.listReleaseCatalogs({ limit: 10 }),
      listDescPaged: [
        ...(await released.listReleaseCatalogs({ limit: 2, order: "desc" })),
        ...(await released.listReleaseCatalogs({
          after: (
            await released.listReleaseCatalogs({ limit: 2, order: "desc" })
          ).at(-1)!.scope_key,
          limit: 2,
          order: "desc",
        })),
      ],
      bases: await Promise.all(
        ["1.0.0", "1.5.0", "2.0.0", "*", "1.x"].map((appVersion) =>
          released.findBaseBundleIds(
            targetBaseCandidateKey({
              appVersion,
              channel: "production",
              fingerprintHash: null,
              platform: "ios",
            })!,
            createBundleFixture("999").id,
            100,
          ),
        ),
      ),
    });
    const before = await calls();
    expect(before.get.filter((row) => row !== null)).toHaveLength(3);
    expect(before.bases.some((ids) => ids.length > 1)).toBe(true);

    await fixture.partition(scopeKeyOf("production"));
    await fixture.partition(scopeKeyOf("beta"));
    const stored = await fixture.readRow(scopeKeyOf("production"));
    expect(stored.payload).toContain('"layout":"partitioned"');

    expect(await calls()).toEqual(before);
  });

  it("answers a released client's retryable read conflict as 503 with its code, not as a catalog", async () => {
    const rows = await fixture.rows(scopeKeyOf("beta"));
    await fixture.deleteRows(scopeKeyOf("beta"), rows.slice(1, 2));
    const response = await server.admin(
      `/release-catalogs/${encodeURIComponent(scopeKeyOf("beta"))}`,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      code: "CATALOG_SNAPSHOT_CONFLICT",
    });
    await expect(
      released.getReleaseCatalogRow(scopeKeyOf("beta")),
    ).rejects.toThrow();
    await fixture.writeRows(scopeKeyOf("beta"), rows.slice(1, 2));
    expect(await released.getReleaseCatalogRow(scopeKeyOf("beta"))).not.toBe(
      null,
    );
  });

  it("reads a scope past today's 256 KB cap as one compact row through the released client", async () => {
    await core.deploy([
      {
        bundle: createBundleFixture("900"),
        release: {
          channel: "big",
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "0.0.1",
        },
      },
    ]);
    const created = await fixture.readRow(scopeKeyOf("big"));
    const releases = Array.from(
      { length: 48 },
      (_, at) =>
        ({
          bundleId: `00000000-0000-7001-8000-${String(at + 1).padStart(12, "0")}`,
          channelId: "channel-big",
          createdAtMs: at,
          enabled: true,
          fingerprintHash: null,
          id: `00000000-0000-7000-8000-${String(at + 1).padStart(12, "0")}`,
          kind: "BUNDLE",
          message: "m".repeat(6_000),
          operation: "DEPLOY",
          platform: "ios",
          revision: 1,
          rolloutCohortCount: 1000,
          shouldForceUpdate: false,
          sourceReleaseId: null,
          strategy: "APP_VERSION",
          targetAppVersion: `${Math.floor(at / 2) + 1}.0.0`,
          targetCohorts: [],
          updatedAtMs: at,
        }) as Release,
    );
    const tiling = (await compileReleaseCatalogTiling({ releases }))!;
    const epoch = crypto.randomUUID();
    await fixture.writeRows(
      scopeKeyOf("big"),
      tiling.map((partition) => ({
        epoch,
        generation: created.generation + 1,
        lowerKey: partition.lowerKey,
        partition,
      })),
    );
    await fixture.publishHead(scopeKeyOf("big"), {
      catalogHash: "sha256:big",
      epoch,
      generation: created.generation + 1,
    });
    const row = (await released.getReleaseCatalogRow(scopeKeyOf("big")))!;
    expect(row.byte_size).toBeGreaterThan(256 * 1024);
    expect(row.payload).toBe(assembleReleaseCatalog(tiling).canonicalPayload);
    expect(row).toEqual(await core.getReleaseCatalogRow(scopeKeyOf("big")));
    expect(
      (await released.listReleaseCatalogs({ limit: 10 })).find(
        (listed) => listed.scope_key === scopeKeyOf("big"),
      ),
    ).toEqual(row);
  });
});
