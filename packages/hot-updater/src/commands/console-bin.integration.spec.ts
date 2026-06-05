import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  type RuntimeChild,
  findOpenPort,
  formatRuntimeLogs,
  spawnRuntime,
  stopRuntime,
  waitForHttpOk,
} from "@hot-updater/test-utils/node";
import { afterEach, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(__dirname, "..", "..", "..", "..");
const consoleRoot = path.join(workspaceRoot, "packages", "console");
const serveBinPath = path.join(consoleRoot, "bin", "serve.mjs");
const configPath = path.join(consoleRoot, "hot-updater.config.ts");

let child: RuntimeChild | null = null;

describe("hot-updater-console serve bin integration", () => {
  afterEach(async () => {
    if (child) {
      await stopRuntime(child);
      child = null;
    }
  });

  it("serves the built console over HTTP", async () => {
    const port = await findOpenPort();
    const runtime = spawnRuntime({
      command: "node",
      args: [
        serveBinPath,
        "--host",
        "127.0.0.1",
        "--port",
        port.toString(),
        "--config",
        configPath,
      ],
      cwd: consoleRoot,
    });
    child = runtime.child;

    await waitForHttpOk({
      child: runtime.child,
      logs: runtime.logs,
      url: `http://127.0.0.1:${port}`,
    });

    const response = await fetch(`http://127.0.0.1:${port}`);
    const html = await response.text();

    expect(response.ok, formatRuntimeLogs(runtime.logs)).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("Hot Updater");
  });

  it("reports a clear error when startup cannot proceed", () => {
    const missingConfigPath = path.join(
      consoleRoot,
      "missing-hot-updater.config.ts",
    );
    const result = spawnSync(
      "node",
      [serveBinPath, "--config", missingConfigPath],
      {
        cwd: consoleRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(missingConfigPath);
  });
});
