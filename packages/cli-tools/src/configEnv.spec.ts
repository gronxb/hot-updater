import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertConfigEnvSet, findUnsetConfigEnv } from "./configEnv";

/** A managed config that reads its Cloudflare credentials with process.env. */
const CONFIG = `import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";

if (process.env.HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID !== "reserved") {
  // A comparison asserts nothing.
}

export default defineConfig({
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
  }),
  database: d1Database({
    databaseId: process.env["HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID"]!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
    region: process.env.REGION ?? "auto",
  }),
});
`;

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-env-"));
  await fs.writeFile(path.join(directory, "hot-updater.config.ts"), CONFIG);
  for (const name of [
    "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
    "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
    "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
    "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
    "REGION",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("findUnsetConfigEnv", () => {
  it("names each variable the config asserts with process.env.<name>! that is unset", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME", "bundles");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID", " ");

    await expect(findUnsetConfigEnv(directory)).resolves.toEqual([
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
      "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
    ]);
  });

  it("finds nothing without a config file", async () => {
    await fs.rm(path.join(directory, "hot-updater.config.ts"));

    await expect(findUnsetConfigEnv(directory)).resolves.toEqual([]);
  });
});

describe("assertConfigEnvSet", () => {
  it("refuses with each unset name and how to set it, in lines of 73 columns at most", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME", "bundles");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID", "database");

    const error = await assertConfigEnvSet(directory).then(
      () => new Error("Expected a rejection."),
      (thrown: unknown) => thrown as Error,
    );

    expect(error.message).toBe(
      [
        "hot-updater.config reads this with process.env, and it is not set:",
        "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
        "Set it in .env.hotupdater, or read it with secretEnv:",
        "https://hot-updater.dev/docs/concepts/secrets",
      ].join("\n"),
    );
    for (const line of error.message.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(73);
    }
  });

  it("passes once every asserted variable is set", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME", "bundles");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID", "database");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_API_TOKEN", "token");

    await expect(assertConfigEnvSet(directory)).resolves.toBeUndefined();
  });
});
