import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { describe, expect, it, vi } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../test-utils/src/databaseTestFixtures";
import { createTableSql } from "../db/schema/sql";
import { createDrizzleCrud } from "./drizzleCrud";
import { createLazyDB } from "./drizzleLazyDB";
import { schema } from "./drizzleTestSchema";
import { createKyselyCrud } from "./kyselyCrud";
import type { MongoCollections } from "./mongodbCollections";
import { createMongoReads } from "./mongodbReads";
import { prismaAdapter } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

describe("ORM physical read projections", () => {
  it.each(["drizzle", "kysely"] as const)(
    "%s reads only the requested fields and decodes selected policy values",
    async (adapter) => {
      const client = new PGlite();
      const queries: string[] = [];
      const db = new Kysely<object>({
        dialect: new PGliteDialect(client),
        log: (event) => {
          queries.push(event.query.sql);
        },
      });
      try {
        await client.exec(createTableSql("postgresql").join(";"));
        const crud =
          adapter === "kysely"
            ? createKyselyCrud(db, "postgresql")
            : createDrizzleCrud(
                createLazyDB({
                  db: drizzle(client, {
                    schema,
                    logger: { logQuery: (query) => queries.push(query) },
                  }),
                  provider: "postgresql",
                }),
                "postgresql",
              );
        const bundle = createBundleRowFixture("1");
        const channel = createChannelRowFixture();
        const release = createReleaseRowFixture("2", bundle, channel);
        await crud.create({ model: "channels", data: channel });
        await crud.create({ model: "bundles", data: bundle });
        await crud.create({ model: "releases", data: release });
        queries.length = 0;
        await expect(
          crud.findOne({
            model: "releases",
            where: [{ field: "id", value: release.id }],
            select: ["revision"],
          }),
        ).resolves.toEqual({ revision: release.revision });
        await expect(
          crud.findMany({
            model: "releases",
            where: [{ field: "id", value: release.id }],
            select: ["enabled", "target_cohorts"],
            limit: 1,
            offset: 0,
          }),
        ).resolves.toEqual([
          {
            enabled: release.enabled,
            target_cohorts: release.target_cohorts,
          },
        ]);
        expect(queries).toHaveLength(2);
        expect(queries[0]).toMatch(/^select "revision" from/i);
        expect(queries[1]).toMatch(/^select "enabled", "target_cohorts" from/i);
      } finally {
        await db.destroy();
        await client.close();
      }
    },
  );

  it("Prisma checks a commit revision without hydrating a Release snapshot", async () => {
    const releaseId = "01900000-0000-7000-8000-000000000007";
    const harness = createPrismaTestHarness();
    const findFirst = vi.fn(async () => ({ revision: 7 }));
    const transaction = {
      ...harness.client,
      releases: { ...harness.client.releases, findFirst },
    };
    const plugin = prismaAdapter({
      provider: "postgresql",
      prisma: {
        ...harness.client,
        $transaction: async (callback: (client: object) => Promise<unknown>) =>
          callback(transaction),
      },
    });
    await expect(
      plugin.commit({
        changes: [],
        expectations: [{ model: "releases", id: releaseId, revision: 7 }],
      }),
    ).resolves.toEqual({ committed: true });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: releaseId },
      select: { revision: true },
    });
  });

  it("MongoDB applies projections to lookups and bounded ordered reads", async () => {
    const cursor = {
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      toArray: async () => [{ revision: 7 }],
    };
    const findOne = vi.fn(async () => ({ revision: 7 }));
    const find = vi.fn(() => cursor);
    const reads = createMongoReads({
      releases: { findOne, find },
    } as unknown as MongoCollections);
    const where = [{ field: "id" as const, value: "release" }];
    await reads.findOne({ model: "releases", where, select: ["revision"] });
    await reads.findMany({
      model: "releases",
      where,
      select: ["revision"],
      limit: 1,
      offset: 0,
    });
    for (const query of [findOne, find]) {
      expect(query).toHaveBeenCalledWith(expect.anything(), {
        projection: { _id: 0, revision: 1 },
      });
    }
  });

  it("MongoDB keeps nullable sorting compatible with a selected-field projection", async () => {
    const aggregate = vi.fn((_pipeline: unknown[]) => ({
      toArray: async () => [{ id: "bundle" }],
    }));
    const reads = createMongoReads({
      bundles: { aggregate },
    } as unknown as MongoCollections);
    await reads.findMany({
      model: "bundles",
      where: [{ field: "platform", value: "ios" }],
      select: ["id"],
      orderBy: [{ field: "git_commit_hash", direction: "asc", nulls: "last" }],
      limit: 2,
      offset: 1,
    });
    const pipeline = aggregate.mock.calls[0]?.[0];
    expect(pipeline?.slice(-3)).toEqual([
      { $skip: 1 },
      { $limit: 2 },
      { $project: { _id: 0, id: 1 } },
    ]);
  });
});
