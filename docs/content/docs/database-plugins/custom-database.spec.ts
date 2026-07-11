import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const guide = readFileSync(new URL("./custom-database.mdx", import.meta.url), {
  encoding: "utf8",
});

describe("custom database provider guide", () => {
  it("shows a complete Kysely dialect wrapper", () => {
    expect(guide).toContain(
      'createKyselyDatabase,\n  type RelationMode,\n} from "@hot-updater/server/adapters/kysely";',
    );
    expect(guide).toContain(
      "new PostgresDialect({ pool: new pg.Pool(poolConfig) })",
    );
    expect(guide).toContain('adapterName: "custom-postgres"');
    expect(guide).toContain('provider: "postgresql"');
  });

  it("imports the CLI config helper from its public package", () => {
    expect(guide).toContain('import { defineConfig } from "hot-updater";');
    expect(guide).not.toContain(
      'import { defineConfig } from "@hot-updater/core";',
    );
    expect(guide).toContain(
      "npx hot-updater db generate src/hotUpdater.ts --yes",
    );
    expect(guide).toContain("npx hot-updater db migrate src/hotUpdater.ts");
    expect(guide).toContain("export const hotUpdater = createHotUpdater({");
    expect(guide).toContain("export const closeDatabase = async () => {");
    expect(guide).toContain("await database.close?.();");
  });
});
