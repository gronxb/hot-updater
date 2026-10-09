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

/** A config an older v0 init wrote: the service-role key as supabaseAnonKey. */
const V0_CONFIG = `import { bare } from "@hot-updater/bare";
import { supabaseDatabase, supabaseStorage } from "@hot-updater/supabase";
import { config } from "dotenv";
import { defineConfig } from "hot-updater";

config({ path: ".env.hotupdater", override: false });

export default defineConfig({
  build: bare({ enableHermes: true }),
  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseAnonKey: process.env.HOT_UPDATER_SUPABASE_ANON_KEY!,
  }),
  updateStrategy: "appVersion",
});
`;

describe("Supabase managed config scaffold", () => {
  it("passes the service-role key as supabaseServiceRoleKey in place of supabaseAnonKey", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-supabase-config-"),
    );
    tempDirs.push(dir);
    const configPath = path.join(dir, "hot-updater.config.ts");
    await fs.writeFile(configPath, V0_CONFIG, "utf8");
    const scaffold = getConfigScaffold("bare");

    const result = await writeHotUpdaterConfig(scaffold, configPath);
    const updated = await fs.readFile(configPath, "utf8");

    expect(result.status).toBe("merged");
    expect(updated).not.toContain("supabaseAnonKey");
    expect(updated).not.toContain("HOT_UPDATER_SUPABASE_ANON_KEY");
    expect(updated).toContain(`  storage: supabaseStorage({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    bucketName: process.env.HOT_UPDATER_SUPABASE_BUCKET_NAME!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),
  database: supabaseDatabase({
    supabaseUrl: process.env.HOT_UPDATER_SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY!,
  }),`);

    await writeHotUpdaterConfig(scaffold, configPath);
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(updated);
  });
});
