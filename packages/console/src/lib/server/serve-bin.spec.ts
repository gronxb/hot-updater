// @vitest-environment node

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
const serveBinPath = path.join(workspaceRoot, "bin", "serve.mjs");

describe("hot-updater-console serve bin", () => {
  it("prints host port and config options in help output", () => {
    const result = spawnSync("node", [serveBinPath, "--help"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--host");
    expect(result.stdout).toContain("--port");
    expect(result.stdout).toContain("--config");
  });

  it("reports a missing config path before importing the server", () => {
    const missingConfigPath = path.join(
      workspaceRoot,
      "missing-hot-updater.config.ts",
    );
    const result = spawnSync(
      "node",
      [serveBinPath, "--config", missingConfigPath],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missingConfigPath);
  });
});
