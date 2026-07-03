import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const sqlPath = path.resolve("plugins/cloudflare/sql/telemetry.sql");
const workerMigrationPath = path.resolve(
  "plugins/cloudflare/worker/migrations/0006_hot-updater_telemetry.sql",
);

describe("Cloudflare telemetry SQL", () => {
  it.each([
    ["shared SQL", sqlPath],
    ["worker migration", workerMigrationPath],
  ])(
    "uses canonical ingest key and analytics event tables in %s",
    async (_label, filePath) => {
      const sql = await fs.readFile(filePath, "utf8");

      expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingest_keys");
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics_events");
      expect(sql).toContain("key_hash TEXT NOT NULL");
      expect(sql).toContain("key_suffix TEXT NOT NULL");
      expect(sql).toContain("active INTEGER NOT NULL DEFAULT 1");
      expect(sql).toContain("event_type TEXT NOT NULL");
      expect(sql).toContain("payload TEXT NOT NULL");
      expect(sql).not.toContain("telemetry_keys");
      expect(sql).not.toContain("bundle_lifecycle_events");
      expect(sql).not.toContain("bundle_install_state");
    },
  );
});
