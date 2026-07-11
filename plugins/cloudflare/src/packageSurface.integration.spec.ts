import path from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(packageRoot, "../..");
const expectedExports = "function,function|function,function";

describe("Cloudflare built package surface integration", () => {
  beforeAll(async () => {
    await execa(
      "pnpm",
      ["nx", "run", "@hot-updater/cloudflare:build", "--skip-nx-cache"],
      { cwd: workspaceRoot },
    );
  }, 120_000);

  it("loads root and Worker exports through ESM", async () => {
    // Given
    const script = `
      const root = await import("@hot-updater/cloudflare");
      const worker = await import("@hot-updater/cloudflare/worker");
      process.stdout.write([
        typeof root.d1Database,
        typeof root.r2Storage,
        "|",
        typeof worker.d1Database,
        typeof worker.r2Storage,
      ].join(",").replace(",|,", "|"));
    `;

    // When
    const result = await execa(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: packageRoot,
      },
    );

    // Then
    expect(result.stdout).toBe(expectedExports);
  });

  it("loads root and Worker exports through CommonJS", async () => {
    // Given
    const script = `
      const root = require("@hot-updater/cloudflare");
      const worker = require("@hot-updater/cloudflare/worker");
      process.stdout.write([
        typeof root.d1Database,
        typeof root.r2Storage,
        "|",
        typeof worker.d1Database,
        typeof worker.r2Storage,
      ].join(",").replace(",|,", "|"));
    `;

    // When
    const result = await execa(
      process.execPath,
      ["--input-type=commonjs", "-e", script],
      {
        cwd: packageRoot,
      },
    );

    // Then
    expect(result.stdout).toBe(expectedExports);
  });
});
