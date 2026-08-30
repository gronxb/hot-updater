import fs from "fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Run the published entry after the workspace build, without a Node `--`
// separator, just like package-manager shims using the portable shebang.
const cliPath = path.resolve(__dirname, "../dist/index.mjs");

describe("CLI init environment file", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hot-updater-cli-"));
    fs.writeFileSync(path.join(cwd, "package.json"), '{"private":true}');
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const runInit = (envFile: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOT_UPDATER_INIT_BUILD: "",
      HOT_UPDATER_INIT_PROVIDER: "",
    };
    delete env["NODE_OPTIONS"];

    return spawnSync(
      process.execPath,
      [cliPath, "init", "--init-env-file", envFile],
      {
        cwd,
        encoding: "utf-8",
        timeout: 10_000,
        env,
      },
    );
  };

  it("reports a missing replay file through Hot Updater", () => {
    const result = runInit("missing.env");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "Init environment file not found:",
    );
  });

  it("does not apply NODE_OPTIONS from the replay file before startup", () => {
    const markerPath = path.join(cwd, "preloaded");
    const preloadPath = path.join(cwd, "preload.cjs");
    fs.writeFileSync(
      preloadPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");`,
    );
    fs.writeFileSync(
      path.join(cwd, "init.env"),
      `NODE_OPTIONS='--require ${JSON.stringify(preloadPath)}'\n`,
    );

    const result = runInit("init.env");

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.stdout + result.stderr).toContain(
      "Init is missing required inputs:",
    );
  });
});
