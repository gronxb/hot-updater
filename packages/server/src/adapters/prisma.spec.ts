import { PGlite } from "@electric-sql/pglite";
import {
  setupDatabasePluginTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { createTableSql } from "../db/schema/sql";
import { createHotUpdater } from "../index";
import { prismaAdapter, type PrismaConfig } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

setupDatabasePluginTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({ ...options, clientAccess: { type: "public" } })
        .handlers,
    ),
  name: "prismaAdapter v2",
  migrate: () => undefined,
  createPlugin: () =>
    prismaAdapter({ prisma: harness.client, provider: "postgresql" }),
  reset: () => harness.reset(),
  dispose: () => undefined,
});

const bundleRow = (id: string) => ({
  id,
  platform: "ios" as const,
  file_hash: "hash",
  git_commit_hash: null,
  storage_uri: "storage://bundle",
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const productionChannel = {
  id: "channel-production",
  name: "production",
} as const;

describe("prismaAdapter capabilities", () => {
  it("rejects every SQL Server Insights operation before touching the database", async () => {
    const plugin = prismaAdapter({ prisma: {}, provider: "mssql" });
    expect(plugin.generateSchema?.("latest").code).not.toContain(
      "bundle_events_to_bundle_idx",
    );
    expect(plugin.generateSchema?.("latest").code).toContain(
      "releases_scope_order_idx",
    );
    const event = createBundleEventRowFixture("707", 100);
    const filter = {
      platform: "ios" as const,
      channel: "production",
      type: "UPDATE_APPLIED" as const,
      toBundleId: event.to_bundle_id,
    };
    const calls = [
      plugin.models.insights.recordEvent({
        event,
      }),
      plugin.models.insights.listEvents({
        filter: { kind: "all" },
        beforeReceivedAtMs: 101,
        limit: 10,
      }),
      plugin.models.insights.findLatestEvents({ installId: event.install_id }),
      plugin.models.insights.countLatestEvents({
        platform: "ios",
        channel: "production",
        sinceMs: 0,
      }),
      plugin.models.insights.countEvents({
        filter,
        sinceMs: 0,
        beforeReceivedAtMs: 101,
      }),
    ];
    for (const call of calls)
      await expect(call).rejects.toThrow("SQL Server Insights is unsupported");
  });
  it("requires callback transactions for atomic event and overview writes", async () => {
    const db = new PGlite();
    await db.exec(createTableSql("postgresql").join(";"));
    let statementId = 0;
    const queryWithPrismaTypes = async (query: string, values: unknown[]) => {
      const statement = `prisma_${statementId++}`;
      const types = values.map((value) =>
        typeof value === "number" ? "double precision" : "text",
      );
      // Prisma supplies string parameter types. Letting PostgreSQL infer UUID here
      // would hide missing casts that fail with the real Prisma client.
      await db.exec(`PREPARE ${statement} (${types.join(", ")}) AS ${query}`);
      try {
        return await db.query(
          `EXECUTE ${statement} (${values.map((value) => (value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`)).join(", ")})`,
        );
      } finally {
        await db.exec(`DEALLOCATE ${statement}`);
      }
    };
    const client = {
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        queryWithPrismaTypes(query, values),
      $queryRawUnsafe: async (query: string, ...values: unknown[]) =>
        (await queryWithPrismaTypes(query, values)).rows,
    };
    const insights = prismaAdapter({ prisma: client, provider: "postgresql" })
      .models.insights;
    const event = createBundleEventRowFixture("704", 100);
    try {
      await expect(insights.recordEvent({ event })).rejects.toThrow(
        "Insights writes require callback transactions",
      );
      expect((await db.query("SELECT id FROM bundle_events")).rows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("rolls back the canonical event when its head update fails and permits retry", async () => {
    const isolated = createPrismaTestHarness();
    const event = createBundleEventRowFixture("705", 100);
    const plugin = prismaAdapter({
      prisma: {
        ...isolated.client,
        $transaction: (callback: (client: object) => Promise<unknown>) =>
          isolated.client.$transaction((transaction) =>
            callback({
              ...transaction,
              $executeRawUnsafe: async () => {
                throw new Error("injected head failure");
              },
            }),
          ),
      },
      provider: "postgresql",
    });
    await expect(plugin.models.insights.recordEvent({ event })).rejects.toThrow(
      "injected head failure",
    );
    const working = prismaAdapter({
      prisma: isolated.client,
      provider: "postgresql",
    });
    await expect(
      working.models.insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([]);
    expect(await isolated.client.bundle_events.findMany()).toEqual([]);
    await expect(
      working.models.insights.getAppUsage({
        channel: event.channel,
        platform: "all",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      }),
    ).resolves.toMatchObject({ activeInstallations: 0 });
    await working.models.insights.recordEvent({ event });
    await expect(
      working.models.insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
  });

  it("maintains release, scope, user, and latest-distribution summaries", async () => {
    const isolated = createPrismaTestHarness();
    const insights = prismaAdapter({
      prisma: isolated.client,
      provider: "postgresql",
    }).models.insights;
    const first = createBundleEventRowFixture("731", 100);
    const second = createBundleEventRowFixture("732", 200);
    const recovery = createBundleEventRowFixture("733", 300);
    const releaseA = first.to_bundle_id;
    const releaseB = second.to_bundle_id;
    const events = [
      {
        ...first,
        type: "UPDATE_DOWNLOADED" as const,
        to_release_id: releaseB,
      },
      {
        ...first,
        id: "00000000-0000-7000-8000-000000000734",
        type: "UNCHANGED" as const,
        from_bundle_id: null,
        from_release_id: null,
        to_release_id: releaseA,
        metadata: { ...first.metadata, update_strategy: null },
      },
      { ...second, to_release_id: releaseB },
      {
        ...recovery,
        type: "RECOVERED" as const,
        from_release_id: releaseB,
        to_release_id: releaseA,
      },
    ];
    await Promise.all(events.map((event) => insights.recordEvent({ event })));
    await insights.recordEvent({ event: events[3]! });
    const references = [releaseA, releaseB].map((releaseId) => ({
      releaseId,
      platform: "ios" as const,
      channel: "production",
    }));
    await expect(
      insights.getReleaseActivity({ releases: references }),
    ).resolves.toMatchObject({
      data: [
        { metrics: { downloads: 0, launches: 2, failedLaunches: 0 } },
        { metrics: { downloads: 1, launches: 1, failedLaunches: 1 } },
      ],
    });
    await expect(
      insights.getReleaseActivity({
        scope: { platform: "ios", channel: "production" },
        timeRange: { start: 0, end: 3_600_000 },
      }),
    ).resolves.toMatchObject({
      data: [
        {
          metrics: {
            downloads: 1,
            launches: 3,
            failedLaunches: 1,
            uniqueUsers: 3,
          },
        },
      ],
    });
    await expect(
      insights.getAppUsage({
        channel: "production",
        platform: "all",
        timeRange: { start: 0, end: 3_600_000 },
        intervalMs: 3_600_000,
      }),
    ).resolves.toMatchObject({
      activeInstallations: 3,
      points: [{ startMs: 0, installations: 3 }],
      bundleDistribution: expect.arrayContaining([
        expect.objectContaining({ releaseId: releaseA, installations: 2 }),
        expect.objectContaining({ releaseId: releaseB, installations: 1 }),
      ]),
    });
  });

  it("retries CockroachDB raw serialization failures without duplicating the event", async () => {
    const isolated = createPrismaTestHarness();
    const event = createBundleEventRowFixture("708", 100);
    let failHead = true;
    const prisma = {
      ...isolated.client,
      $transaction: (
        callback: (client: object) => Promise<unknown>,
        options?: { readonly isolationLevel?: string },
      ) =>
        isolated.client.$transaction(
          (transaction) =>
            callback({
              ...transaction,
              $executeRawUnsafe: (
                ...args: Parameters<typeof isolated.client.$executeRawUnsafe>
              ) => {
                if (failHead) {
                  failHead = false;
                  throw Object.assign(new Error("could not serialize access"), {
                    code: "P2010",
                    meta: { code: "40001" },
                  });
                }
                return Reflect.get(transaction, "$executeRawUnsafe")(...args);
              },
            }),
          options,
        ),
    };
    const insights = prismaAdapter({ prisma, provider: "cockroachdb" }).models
      .insights;
    await insights.recordEvent({ event });
    expect(await isolated.client.bundle_events.findMany()).toEqual([event]);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
    expect(isolated.getTransactionOptions()).toEqual([
      { isolationLevel: "Serializable" },
      { isolationLevel: "Serializable" },
    ]);
  });

  it("retries sustained serializable write conflicts", async () => {
    const isolated = createPrismaTestHarness();
    const event = createBundleEventRowFixture("709", 100);
    let attempts = 0;
    const prisma = {
      ...isolated.client,
      $transaction: (
        callback: (client: object) => Promise<unknown>,
        options?: { readonly isolationLevel?: string },
      ) => {
        attempts += 1;
        if (attempts < 5) {
          return Promise.reject(
            Object.assign(new Error("write conflict"), { code: "P2034" }),
          );
        }
        return isolated.client.$transaction(callback, options);
      },
    };
    const insights = prismaAdapter({ prisma, provider: "postgresql" }).models
      .insights;

    await insights.recordEvent({ event });

    expect(attempts).toBe(5);
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
  });

  it("counts MySQL overlapping bundle predicates once without dropping nullable source bundles", async () => {
    const isolated = createPrismaTestHarness();
    const writer = prismaAdapter({
      prisma: isolated.client,
      provider: "postgresql",
    }).models.insights;
    const base = createBundleEventRowFixture("720", 100);
    const applied = { ...base, from_bundle_id: base.to_bundle_id };
    const download = {
      ...createBundleEventRowFixture("721", 100),
      type: "UPDATE_DOWNLOADED" as const,
      from_bundle_id: base.to_bundle_id,
    };
    const unchanged = {
      ...createBundleEventRowFixture("722", 100),
      type: "UNCHANGED" as const,
      from_bundle_id: null,
      to_bundle_id: base.to_bundle_id,
      metadata: { ...base.metadata, update_strategy: null },
    };
    for (const event of [applied, download, unchanged])
      await writer.recordEvent({ event });
    let queries = 0;
    const reader = prismaAdapter({
      prisma: {
        ...isolated.client,
        $queryRawUnsafe: (
          ...args: Parameters<typeof isolated.client.$queryRawUnsafe>
        ) => {
          queries += 1;
          return isolated.client.$queryRawUnsafe(...args);
        },
      },
      provider: "mysql",
    }).models.insights;
    const source = {
      field: "from_bundle_id" as const,
      value: base.to_bundle_id,
      types: ["UPDATE_APPLIED", "UPDATE_DOWNLOADED"] as const,
    };
    const destination = {
      field: "to_bundle_id" as const,
      value: base.to_bundle_id,
      types: ["UPDATE_APPLIED", "UNCHANGED"] as const,
    };
    for (const [bundle, expected] of [
      [[source, destination], 3],
      [[destination, destination], 2],
      [[{ ...source, types: ["UNCHANGED"] }, destination], 2],
      [[destination], 2],
    ] as const) {
      await expect(
        reader.countLatestEvents({
          platform: "ios",
          channel: "production",
          sinceMs: 0,
          bundle,
        }),
      ).resolves.toBe(expected);
    }
    expect(queries).toBe(4);
  });

  it("excludes MongoDB from the public configuration", () => {
    expectTypeOf<"mongodb">().not.toMatchTypeOf<PrismaConfig["provider"]>();
  });

  it("returns a named provider adapter", () => {
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    expect(plugin.name).toBe("prisma");
    expect(plugin.adapterName).toBe("prisma");
    expect(plugin.provider).toBe("postgresql");
  });

  it("rejects MongoDB before creating the implementation", () => {
    expect(() =>
      Reflect.apply(prismaAdapter, undefined, [
        { prisma: harness.client, provider: "mongodb" },
      ]),
    ).toThrow("Prisma adapter does not support MongoDB");
  });

  it("does not expose low-level transactions", () => {
    const { $transaction: _transaction, ...client } = harness.client;
    const plugin = prismaAdapter({ prisma: client, provider: "postgresql" });

    expect(Reflect.has(plugin, "transaction")).toBe(false);
  });

  it("requires transactions for emulated relations", () => {
    const { $transaction: _transaction, ...client } = harness.client;

    expect(() =>
      prismaAdapter({
        prisma: client,
        provider: "postgresql",
        relationMode: "prisma",
      }),
    ).toThrow('relation mode "prisma" requires callback transactions');
  });

  it("uses serializable transactions for emulated relation commits", async () => {
    harness.reset();
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
      relationMode: "prisma",
    });
    const base = bundleRow("bundle-base");
    const owner = bundleRow("bundle-target");
    const patch = {
      id: "patch-1",
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "base-hash",
      patch_file_hash: "patch-hash",
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_000_002,
      order_index: 0,
    };

    await plugin.models.channels.insert({
      row: productionChannel,
      onConflict: "returnExisting",
    });

    await plugin.commit({
      changes: [{ model: "bundles", operation: "insert", row: base }],
    });
    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: owner },
        { model: "bundlePatches", operation: "insert", row: patch },
      ],
    });
    await plugin.commit({
      changes: [
        {
          model: "bundles",
          operation: "delete",
          where: { id: owner.id },
        },
      ],
    });

    expect(harness.getTransactionOptions()).toEqual(
      Array.from({ length: 3 }, () => ({ isolationLevel: "Serializable" })),
    );
  });

  it("uses serializable transactions for atomic CAS commits", async () => {
    harness.reset();
    const plugin = prismaAdapter({
      prisma: harness.client,
      provider: "postgresql",
    });

    await plugin.commit({
      changes: [
        { model: "bundles", operation: "insert", row: bundleRow("bundle") },
      ],
    });

    expect(harness.getTransactionOptions()).toEqual([
      { isolationLevel: "Serializable" },
    ]);
  });

  it("does not delete patches before a bundle delete fails", async () => {
    harness.reset();
    const { $transaction: _transaction, ...client } = harness.client;
    const plugin = prismaAdapter({ prisma: client, provider: "postgresql" });
    const base = bundleRow("bundle-base");
    const owner = bundleRow("bundle-target");
    const patch = {
      id: "patch-1",
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "base-hash",
      patch_file_hash: "patch-hash",
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_000_002,
      order_index: 0,
    };
    await plugin.models.channels.insert({
      row: productionChannel,
      onConflict: "returnExisting",
    });
    for (const row of [base, owner]) {
      await plugin.commit({
        changes: [{ model: "bundles", operation: "insert", row }],
      });
    }
    await plugin.commit({
      changes: [{ model: "bundlePatches", operation: "insert", row: patch }],
    });

    harness.failNextBundleDelete();
    await expect(
      plugin.commit({
        changes: [
          {
            model: "bundles",
            operation: "delete",
            where: { id: owner.id },
          },
        ],
      }),
    ).rejects.toThrow("injected bundle delete failure");
    await expect(
      plugin.models.bundles.findById(owner.id),
    ).resolves.toMatchObject({
      id: owner.id,
    });
    await expect(
      plugin.models.bundlePatches.findByBundleIds([owner.id]),
    ).resolves.toEqual([patch]);
  });
});
