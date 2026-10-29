import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertConfigEnvSet,
  findUnsetConfigEnv,
  recordUnsetEnvReads,
  trackUnsetEnvReads,
} from "./configEnv";

/** A managed config that reads its Cloudflare credentials with process.env. */
const CONFIG = `import { d1Database, r2Storage } from "@hot-updater/cloudflare";
import { defineConfig } from "hot-updater";

// cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_OLD_TOKEN!,
/* region: process.env.HOT_UPDATER_CLOUDFLARE_REGION!, */
export default defineConfig({
  storage: r2Storage({
    bucketName: process.env.HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
  }),
  database: d1Database({
    databaseId: process.env["HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID"]!,
    accountId: process.env.HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID!,
    cloudflareApiToken: process.env.HOT_UPDATER_CLOUDFLARE_API_TOKEN!,
    jurisdiction: process.env.HOT_UPDATER_CLOUDFLARE_JURISDICTION! ?? "default",
  }),
});
`;

const NAMES = [
  "HOT_UPDATER_CLOUDFLARE_OLD_TOKEN",
  "HOT_UPDATER_CLOUDFLARE_REGION",
  "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
  "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
  "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
  "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
  "HOT_UPDATER_CLOUDFLARE_JURISDICTION",
];

/** A config whose evaluation read every name in `NAMES` while it was unset. */
const loaded = () => {
  const config = {};
  recordUnsetEnvReads(config, new Set(NAMES));
  return config;
};

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-env-"));
  await fs.writeFile(path.join(directory, "hot-updater.config.ts"), CONFIG);
  for (const name of NAMES) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { force: true, recursive: true });
});

describe("trackUnsetEnvReads", () => {
  it("records the variables read while unset or empty, and restores process.env", async () => {
    const env = process.env;
    vi.stubEnv("HOT_UPDATER_SPEC_SET", "value");
    vi.stubEnv("HOT_UPDATER_SPEC_EMPTY", "");
    const reads = new Set<string>();

    await trackUnsetEnvReads(reads, async () => {
      void process.env.HOT_UPDATER_SPEC_SET;
      void process.env.HOT_UPDATER_SPEC_EMPTY;
      void process.env.HOT_UPDATER_SPEC_UNSET;
      process.env.HOT_UPDATER_SPEC_WRITTEN = "written";
    });

    expect([...reads]).toEqual([
      "HOT_UPDATER_SPEC_EMPTY",
      "HOT_UPDATER_SPEC_UNSET",
    ]);
    expect(process.env).toBe(env);
    expect(process.env.HOT_UPDATER_SPEC_WRITTEN).toBe("written");
    delete process.env.HOT_UPDATER_SPEC_WRITTEN;
  });
});

describe("findUnsetConfigEnv", () => {
  it("names each variable read unset that the config asserts outside comments, without a fallback", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME", "bundles");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID", " ");

    await expect(findUnsetConfigEnv(loaded(), directory)).resolves.toEqual([
      "HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID",
      "HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID",
      "HOT_UPDATER_CLOUDFLARE_API_TOKEN",
    ]);
  });

  it("names nothing the config's evaluation didn't read, such as a branch that didn't run", async () => {
    const config = {};
    recordUnsetEnvReads(
      config,
      new Set(["HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME"]),
    );

    await expect(findUnsetConfigEnv(config, directory)).resolves.toEqual([
      "HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME",
    ]);
    await expect(findUnsetConfigEnv({}, directory)).resolves.toEqual([]);
  });

  it("finds nothing without a config file", async () => {
    await fs.rm(path.join(directory, "hot-updater.config.ts"));

    await expect(findUnsetConfigEnv(loaded(), directory)).resolves.toEqual([]);
  });
});

describe("assertConfigEnvSet", () => {
  it("refuses with each unset name and how to set it, in lines of 73 columns at most", async () => {
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_R2_BUCKET_NAME", "bundles");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID", "database");

    const error = await assertConfigEnvSet(loaded(), directory).then(
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

    await expect(
      assertConfigEnvSet(loaded(), directory),
    ).resolves.toBeUndefined();
  });
});
