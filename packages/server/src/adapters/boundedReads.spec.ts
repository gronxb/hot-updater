import { describe, expect, it, vi } from "vitest";

import type { MongoCollections } from "./mongodbCollections";
import { createMongoReads } from "./mongodbReads";
import { prismaAdapter } from "./prisma";
import { createPrismaTestHarness } from "./prismaTestClient";

describe("ORM bounded pagination", () => {
  it("keeps Prisma pagination in the database when null ordering is supplied", async () => {
    const findMany = vi.fn(async () => []);
    const harness = createPrismaTestHarness();
    const plugin = prismaAdapter({
      prisma: {
        ...harness.client,
        bundles: { ...harness.client.bundles, findMany },
      },
      provider: "postgresql",
    });
    const orderBy = {
      field: "id" as const,
      direction: "asc" as const,
      nulls: "last" as const,
    };
    await plugin.models.bundles.findMany({
      limit: 2,
      offset: 5,
      orderBy,
    });
    expect(findMany).toHaveBeenCalledExactlyOnceWith({
      where: {},
      orderBy: [{ id: "asc" }],
      skip: 5,
      take: 2,
    });
  });

  it("uses indexable MongoDB predicates for a finite bundle id set", async () => {
    const cursor = {
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => []),
    };
    const find = vi.fn((_where: unknown, _options: unknown) => cursor);
    await createMongoReads({
      bundles: { find },
    } as unknown as MongoCollections).findMany({
      model: "bundles",
      where: [{ field: "id", operator: "in", value: ["one", "two"] }],
      limit: 2,
      offset: 0,
    });
    expect(find.mock.calls[0]?.[0]).toEqual({
      $and: [
        { id: { $in: ["one", "two"] } },
        { _hot_updater_deletion_token: { $exists: false } },
      ],
    });
  });

  it("does not fetch all MongoDB rows to sort nullable fields", async () => {
    const aggregate = vi.fn((_pipeline: unknown[]) => ({
      toArray: async () => [],
    }));
    const cursor = {
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => {
        throw new Error("unbounded sort fallback");
      }),
    };
    const find = vi.fn((_where: unknown, _options: unknown) => cursor);
    const reads = createMongoReads({
      bundles: { find, aggregate },
    } as unknown as MongoCollections);
    await reads.findMany({
      model: "bundles",
      where: [{ field: "platform", value: "ios" }],
      orderBy: [
        { field: "git_commit_hash", direction: "asc", nulls: "last" },
        { field: "id", direction: "asc" },
      ],
      limit: 2,
      offset: 5,
    });
    expect(find).not.toHaveBeenCalled();
    expect(aggregate).toHaveBeenCalledOnce();
    const stages = aggregate.mock.calls[0]?.[0];
    expect(stages).toEqual(
      expect.arrayContaining([{ $skip: 5 }, { $limit: 2 }]),
    );
  });
});
