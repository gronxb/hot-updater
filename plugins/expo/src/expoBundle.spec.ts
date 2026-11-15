import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

vi.mock("execa", () => {
  class ExecaError extends Error {}
  return {
    ExecaError,
    // Node crashing with an access violation during the export, as on
    // Windows: npm's warning is all stderr holds.
    execa: vi.fn(async () => {
      throw Object.assign(new ExecaError("Command failed"), {
        exitCode: 3221225477,
        stderr: "npm warn config production Use --omit=dev instead.",
        stdout: "Starting Metro Bundler",
        all: "Starting Metro Bundler\nnpm warn config production Use --omit=dev instead.",
      });
    }),
  };
});
vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  assertSupportedExpoSdk: vi.fn(),
}));
vi.mock("./resolveMain", () => ({ resolveMain: () => "index.js" }));
vi.mock("./expoConfig", () => ({
  getConfig: vi.fn(async () => ({ exp: { jsEngine: "jsc" } })),
  getConfigPlugins: vi.fn(),
}));

import { expo } from "./expo";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it("fails the export with its exit code and last output, not stderr alone", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-bundle-"));
  tempDirs.push(cwd);

  const error = await expo()({ cwd })
    .build({ platform: "android" })
    .then(
      () => null,
      (reason: unknown) => reason,
    );

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    [
      "expo export:embed exited with code 3221225477 (0xC0000005).",
      "Starting Metro Bundler",
      "npm warn config production Use --omit=dev instead.",
    ].join("\n"),
  );
});
