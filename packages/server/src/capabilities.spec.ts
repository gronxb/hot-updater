import { describe, expect, expectTypeOf, it } from "vitest";

import { createHotUpdater } from "./capabilities";
import type { DatabasePluginFactory, ORMProvider } from "./db/types";

const createSchemaOnlyAdapter = ({
  code,
  name,
  provider,
  path,
}: {
  readonly code: string;
  readonly name: string;
  readonly provider: ORMProvider;
  readonly path: string;
}): DatabasePluginFactory => {
  const factory: DatabasePluginFactory = () => ({
    name,
    async getBundleById() {
      return null;
    },
    async getBundles() {
      return {
        data: [],
        pagination: {
          currentPage: 1,
          hasNextPage: false,
          hasPreviousPage: false,
          total: 0,
          totalPages: 0,
        },
      };
    },
    async getChannels() {
      return [];
    },
    async appendBundle() {},
    async updateBundle() {},
    async deleteBundle() {},
    async commitBundle() {},
  });
  factory.adapterName = name;
  factory.provider = provider;
  factory.generateSchema = () => {
    return {
      code,
      path,
    };
  };
  return factory;
};

describe("server capabilities", () => {
  it("exposes database capabilities through the capabilities subpath", () => {
    const hotUpdater = createHotUpdater({
      database: createSchemaOnlyAdapter({
        code: "export const bundles = {};",
        name: "drizzle",
        path: "hot-updater-schema.ts",
        provider: "postgresql",
      }),
    });

    expect(hotUpdater.adapterName).toBe("drizzle");
    expect(hotUpdater.generateSchema("latest").path).toBe(
      "hot-updater-schema.ts",
    );
    expect(hotUpdater.createMigrator).toEqual(expect.any(Function));
    expectTypeOf(hotUpdater).toHaveProperty("generateSchema");
    expectTypeOf(hotUpdater).toHaveProperty("createMigrator");
  });
});
