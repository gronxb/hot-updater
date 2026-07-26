import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "fixtures",
  "deploy-lifecycle-child",
);
const cliPath = path.resolve(import.meta.dirname, "../../dist/index.mjs");

const runDeployChild = (
  mode: "success" | "abort" | "failure",
): Readonly<{
  marker: string;
  status: number | null;
  stderr: string;
}> => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), `hot-updater-deploy-${mode}-`),
  );
  const markerPath = path.join(temporaryDirectory, "disposed.marker");
  const args = [
    cliPath,
    "deploy",
    "--platform",
    "ios",
    ...(mode === "abort" ? [] : ["--target-app-version", "1.0.x"]),
  ];
  try {
    const child = spawnSync(process.execPath, args, {
      cwd: fixtureDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        HOT_UPDATER_DEPLOY_LIFECYCLE_MARKER: markerPath,
        HOT_UPDATER_DEPLOY_LIFECYCLE_MODE: mode,
        HOT_UPDATER_DEPLOY_LIFECYCLE_WORKDIR: temporaryDirectory,
      },
    });

    return {
      marker: readFileSync(markerPath, "utf8"),
      status: child.status,
      stderr: child.stderr,
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    rmSync(path.join(fixtureDirectory, ".hot-updater"), {
      force: true,
      recursive: true,
    });
  }
};

describe("built deploy CLI storage lifecycle", () => {
  it.each([
    { expectedStatus: 0, mode: "success" },
    { expectedStatus: 0, mode: "abort" },
    { expectedStatus: 1, mode: "failure" },
  ] as const)(
    "writes the disposal marker before $mode exit",
    ({ expectedStatus, mode }) => {
      // Given
      const expectedMarker = "storage-disposed\n";

      // When
      const child = runDeployChild(mode);

      // Then
      expect(child.status, child.stderr).toBe(expectedStatus);
      expect(child.marker).toBe(expectedMarker);
    },
  );
});
