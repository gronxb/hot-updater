import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readDocument = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("Cloudflare database entrypoint documentation", () => {
  it.each([
    ["README", "../../../../README.md"],
    ["managed guide", "../managed/cloudflare.mdx"],
  ])(
    "uses the Node entrypoint and D1 REST credentials in the %s",
    (_, path) => {
      const document = readDocument(path);

      expect(document).toContain(
        'import { d1Database, r2Storage } from "@hot-updater/cloudflare";',
      );
      expect(document).toContain(
        "databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!",
      );
      expect(document).toContain(
        "cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!",
      );
      expect(document).not.toContain(
        'import { d1Database } from "@hot-updater/cloudflare/worker";',
      );
    },
  );

  it("keeps Worker bindings on the worker subpath", () => {
    const guide = readDocument("./cloudflare.mdx");

    expect(guide).toContain(
      'import { d1Database } from "@hot-updater/cloudflare/worker";',
    );
    expect(guide).toContain(
      'import { d1Database, r2Storage } from "@hot-updater/cloudflare/worker";',
    );
    expect(guide).toContain(
      "databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!",
    );
    expect(guide).not.toContain('from "kysely-d1"');
  });
});
