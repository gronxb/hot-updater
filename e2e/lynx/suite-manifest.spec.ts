import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("Lynx E2E suite manifest", () => {
  it("dry-run plans the default Detox suite names", () => {
    const expected = JSON.parse(
      readFileSync(
        path.join(repoDir, "e2e/detox/default-scenario-names.json"),
        "utf8",
      ),
    ) as string[];
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        path.join(repoDir, "e2e/lynx/scripts/run.ts"),
        "--dry-run",
        "--platform",
        "ios",
      ],
      { cwd: repoDir, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const planned = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\s+/.test(line))
      .map((line) => line.replace(/^\d+\.\s+/, ""));
    expect(planned).toEqual(expected);
  });

  it("bootstraps CocoaPods before the iOS e2e native build", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/scripts/build-e2e-native.mjs"),
      "utf8",
    );
    expect(source).toContain('run("sh", ["bootstrap.sh"], iosDir)');
    expect(source).toContain("-derivedDataPath");
    expect(source).toContain("build");
  });

  it("declares bundle signing so agent setup can export the public key", () => {
    const source = readFileSync(
      path.join(repoDir, "examples/lynx/hot-updater.config.ts"),
      "utf8",
    );
    expect(source).toContain('privateKeyPath: "./keys/private-key.pem"');
    expect(source).toMatch(/signing:\s*\{[\s\S]*enabled:\s*true/);
  });
});
