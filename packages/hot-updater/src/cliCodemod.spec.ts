import fs from "fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Run the published entry after the workspace build, as users do.
const cliPath = path.resolve(__dirname, "../dist/index.mjs");

const RC_SERVER = `import { createHotUpdater } from "@hot-updater/server";

export const hotUpdater = createHotUpdater({
  database,
  clientAccess: { type: "api-key", headerName: "x-hot-updater-key" },
});
`;

const MIGRATED_SERVER = `import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins/api-keys";
import { insights } from "@hot-updater/server/plugins/insights";

export const hotUpdater = createHotUpdater({
  database,
  plugins: [insights(), apiKeys({ headerName: "x-hot-updater-key" })],
});
`;

describe("hot-updater codemod client-access", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hot-updater-codemod-cli-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [cliPath, "codemod", "client-access", ...args],
      {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 10_000,
      },
    );

  it("previews and then writes the rewrite of a release candidate server", () => {
    // Given a server file from a 1.0 release candidate
    const file = path.join(cwd, "server.ts");
    fs.writeFileSync(file, RC_SERVER);

    // When the built CLI runs a dry run, then writes
    const dryRun = run("--dry-run");
    const unchangedByDryRun = fs.readFileSync(file, "utf-8");
    const write = run("server.ts");

    // Then the dry run prints the diff only, and the write applies it
    expect(dryRun.error).toBeUndefined();
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("--- a/server.ts");
    expect(dryRun.stdout).toContain(
      '+  plugins: [insights(), apiKeys({ headerName: "x-hot-updater-key" })],',
    );
    expect(unchangedByDryRun).toBe(RC_SERVER);
    expect(write.status).toBe(0);
    expect(fs.readFileSync(file, "utf-8")).toBe(MIGRATED_SERVER);
  });
});
