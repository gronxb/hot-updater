import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeHotUpdaterConfig } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it } from "vitest";

import { getConfigScaffold } from "./configTemplate";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** A config an older v0 init wrote: R2 storage through the Wrangler token. */
const V0_CONFIG = `import { bare } from "@hot-updater/bare";
import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater", override: false });

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),
  updateStrategy: "appVersion",
});
`;

describe("Cloudflare managed config scaffold", () => {
  it("gives r2Storage R2 credentials in place of the Wrangler token, which d1Database keeps", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-cloudflare-config-"),
    );
    tempDirs.push(dir);
    const configPath = path.join(dir, "hot-updater.config.ts");
    await fs.writeFile(configPath, V0_CONFIG, "utf8");
    const scaffold = getConfigScaffold("bare");

    const result = await writeHotUpdaterConfig(scaffold, configPath);
    const updated = await fs.readFile(configPath, "utf8");

    expect(result.status).toBe("merged");
    expect(updated).toContain(`  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    credentials: {
      accessKeyId: process.env.HOT_UPDATER_CLOUDFLARE_R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.HOT_UPDATER_CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
    },
  }),`);
    expect(updated.match(/cloudflareApiToken:/gu)).toHaveLength(1);
    expect(updated).toContain(`  database: d1Database({
    databaseId: process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
  }),`);

    await writeHotUpdaterConfig(scaffold, configPath);
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(updated);
  });
});
