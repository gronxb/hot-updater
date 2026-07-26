import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

it.each([
  ["cancel", 2],
  ["failure", 1],
] as const)(
  "finishes promote %s cleanup before the child process exits",
  async (mode, expectedExitCode) => {
    const fixtureDirectory = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "hot-updater-promote-lifecycle-"),
    );
    const markerPath = path.join(fixtureDirectory, `${mode}.marker`);

    try {
      const child = spawnSync(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "packages/hot-updater/src/commands/fixtures/promote-lifecycle-child.spec.ts",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOT_UPDATER_PROMOTE_LIFECYCLE_MARKER: markerPath,
            HOT_UPDATER_PROMOTE_LIFECYCLE_MODE: mode,
          },
        },
      );

      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(
        fs.existsSync(markerPath),
        `${child.stdout}\n${child.stderr}`,
      ).toBe(true);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(
        `storage\ndatabase\nhandled:${expectedExitCode}\nexit:${expectedExitCode}\n`,
      );
    } finally {
      await fsPromises.rm(fixtureDirectory, {
        recursive: true,
        force: true,
      });
    }
  },
);
