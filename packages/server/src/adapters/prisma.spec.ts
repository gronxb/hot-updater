import { PGlite } from "@electric-sql/pglite";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createBundleEventRowFixture } from "../../../test-utils/src/databaseTestFixtures";
import { setupDatabasePluginTestSuite } from "../../../test-utils/src/setupDatabasePluginTestSuite";
import { createTableSql } from "../db/schema/sql";
import { prismaAdapter, type PrismaConfig } from "./prisma";
import { updatePrismaEventHead } from "./prismaInsights";
import { createPrismaTestHarness } from "./prismaTestClient";

const harness = createPrismaTestHarness();

setupDatabasePluginTestSuite({
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
  it("atomically records Insights without callback transactions using Prisma text-bound UUIDs", async () => {
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
      await insights.recordEvent({ event });
      await updatePrismaEventHead(client, "postgresql", event);
      await insights.recordEvent({
        event: { ...event, install_id: "altered-install", received_at_ms: 300 },
      });
      await expect(
        insights.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([event]);
      await expect(
        insights.findLatestEvents({ installId: "altered-install" }),
      ).resolves.toEqual([]);
      expect((await db.query("SELECT id FROM bundle_events")).rows).toEqual([
        { id: event.id },
      ]);
      await expect(
        insights.countLatestEvents({
          platform: event.platform,
          channel: event.channel,
          sinceMs: 0,
          bundle: [
            {
              field: "to_bundle_id",
              value: event.to_bundle_id,
              types: [event.type],
            },
          ],
        }),
      ).resolves.toBe(1);

      await db.exec(
        "ALTER TABLE bundle_event_heads ADD CONSTRAINT reject_head CHECK (received_at_ms < 200)",
      );
      const rejected = {
        ...event,
        id: createBundleEventRowFixture("706", 200).id,
        received_at_ms: 200,
      };
      await expect(insights.recordEvent({ event: rejected })).rejects.toThrow();
      expect((await db.query("SELECT id FROM bundle_events")).rows).toEqual([
        { id: event.id },
      ]);
      await expect(
        insights.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([event]);
      await db.exec(
        "ALTER TABLE bundle_event_heads DROP CONSTRAINT reject_head",
      );
      await insights.recordEvent({ event: rejected });
      await expect(
        insights.findLatestEvents({ installId: event.install_id }),
      ).resolves.toEqual([rejected]);
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
    await working.models.insights.recordEvent({ event });
    await expect(
      working.models.insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
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
      id: `${owner.id}:${base.id}`,
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "a".repeat(64),
      patch_file_hash: "b".repeat(64),
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_002,
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
      id: `${owner.id}:${base.id}`,
      bundle_id: owner.id,
      base_bundle_id: base.id,
      base_file_hash: "a".repeat(64),
      patch_file_hash: "b".repeat(64),
      patch_storage_uri: "storage://patch",
      byte_size: 3_000_002,
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
