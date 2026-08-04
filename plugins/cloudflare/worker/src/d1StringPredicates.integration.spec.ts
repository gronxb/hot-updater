import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { d1WorkerDatabase } from "../../src/cloudflareWorkerDatabase";

const plugin = d1WorkerDatabase(env.DB);

const sensitiveCases = [
  {
    operator: "contains",
    upper: "preview Gamma release",
    lower: "preview gamma release",
  },
  {
    operator: "starts_with",
    upper: "Gamma release",
    lower: "gamma release",
  },
  {
    operator: "ends_with",
    upper: "preview Gamma",
    lower: "preview gamma",
  },
] as const;

const seedMessage = async (id: string, message: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO bundles (
      id, platform, target_app_version, should_force_update, enabled,
      file_hash, message, channel, storage_uri
    ) VALUES (?, 'ios', '1.0.0', 0, 1, ?, ?, 'production', ?)`,
  )
    .bind(id, `hash-${id}`, message, `storage://${id}`)
    .run();
};

describe("D1 string predicates", () => {
  beforeAll(async () => {
    await env.DB.prepare(inject("prepareSql")).run();
  });

  beforeEach(async () => {
    await env.DB.prepare(
      "DELETE FROM bundle_patches; DELETE FROM bundles;",
    ).run();
  });

  it.each(sensitiveCases)(
    "keeps default $operator matching case-sensitive when reading",
    async ({ operator, upper, lower }) => {
      await seedMessage("upper", upper);
      await seedMessage("lower", lower);

      const rows = await plugin.findMany({
        model: "bundles",
        where: [{ field: "message", operator, value: "gamma" }],
        select: ["id"],
      });

      expect(rows).toEqual([{ id: "lower" }]);
    },
  );

  it("keeps explicit sensitive contains matching case-sensitive when deleting", async () => {
    await seedMessage("upper", "Gamma");
    await seedMessage("lower", "gamma");

    await plugin.delete({
      model: "bundles",
      where: [
        {
          field: "message",
          operator: "contains",
          value: "gamma",
          mode: "sensitive",
        },
      ],
    });

    await expect(
      plugin.findMany({ model: "bundles", select: ["id"] }),
    ).resolves.toEqual([{ id: "upper" }]);
  });

  it("matches literal wildcard characters with contains, starts_with, and ends_with", async () => {
    await seedMessage("literal", "start%_end");
    await seedMessage("different", "startXXend");

    const [contains, startsWith, endsWith] = await Promise.all([
      plugin.findMany({
        model: "bundles",
        where: [{ field: "message", operator: "contains", value: "%_" }],
        select: ["id"],
      }),
      plugin.findMany({
        model: "bundles",
        where: [
          { field: "message", operator: "starts_with", value: "start%_" },
        ],
        select: ["id"],
      }),
      plugin.findMany({
        model: "bundles",
        where: [{ field: "message", operator: "ends_with", value: "%_end" }],
        select: ["id"],
      }),
    ]);

    expect(contains).toEqual([{ id: "literal" }]);
    expect(startsWith).toEqual([{ id: "literal" }]);
    expect(endsWith).toEqual([{ id: "literal" }]);
  });

  it("matches every non-null string when ends_with receives an empty value", async () => {
    await seedMessage("first", "Gamma");
    await seedMessage("second", "");

    const rows = await plugin.findMany({
      model: "bundles",
      where: [{ field: "message", operator: "ends_with", value: "" }],
      select: ["id"],
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(rows).toEqual([{ id: "first" }, { id: "second" }]);
  });

  it("keeps escaped insensitive matching case-insensitive", async () => {
    await seedMessage("upper", "Gamma%_Preview");
    await seedMessage("lower", "gamma%_preview");
    await seedMessage("wildcard", "gammaXXpreview");

    const rows = await plugin.findMany({
      model: "bundles",
      where: [
        {
          field: "message",
          operator: "contains",
          value: "GAMMA%_PREVIEW",
          mode: "insensitive",
        },
      ],
      select: ["id"],
      orderBy: [{ field: "id", direction: "asc" }],
    });

    expect(rows).toEqual([{ id: "lower" }, { id: "upper" }]);
  });
});
