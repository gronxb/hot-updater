import { describe, expect, it } from "vitest";

import { createPrismaDatabase, prismaAdapter, prismaDatabase } from "./prisma";

describe("prismaAdapter", () => {
  it("exposes Prisma as the official database middle layer with the old alias", () => {
    expect(prismaDatabase).toBe(createPrismaDatabase);
    expect(prismaAdapter).toBe(prismaDatabase);
  });

  it("exposes Prisma as the middle layer and provider as the database layer", () => {
    const adapter = prismaDatabase({
      prisma: {},
      provider: "postgresql",
    });

    expect(adapter.adapterName).toBe("prisma");
    expect(adapter.provider).toBe("postgresql");

    if (!adapter.generateSchema) {
      throw new Error("Prisma adapter must provide schema generation.");
    }

    const schema = adapter.generateSchema("latest");

    expect(schema.path).toBe("./prisma/schema/hot_updater.prisma");
    expect(schema.code).toContain("model bundles");
    expect(schema.code).toContain("@db.Uuid");
  });
});
