import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@hot-updater/cli-tools", () => ({
  getPackageManager: () => "pnpm",
  p: { log: { info: mocks.info, warn: mocks.warn } },
}));

import { validateExpoProject } from "./projectValidation";

const projects: string[] = [];

const createProject = async (manifest: object, appJson?: object) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-validation-"));
  projects.push(cwd);
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify(manifest));
  if (appJson) {
    await fs.writeFile(path.join(cwd, "app.json"), JSON.stringify(appJson));
  }
  return cwd;
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    projects
      .splice(0)
      .map((project) => fs.rm(project, { recursive: true, force: true })),
  );
});

describe("Expo project validation", () => {
  it("rejects a project where a second update controller is installed", async () => {
    const cwd = await createProject({
      dependencies: { "expo-updates": "latest" },
    });

    expect(() => validateExpoProject({ command: "deploy", cwd })).toThrow(
      "pnpm remove expo-updates",
    );
  });

  it("explains generated native configuration before a direct mutation", async () => {
    const cwd = await createProject({ dependencies: {} }, { expo: {} });

    validateExpoProject({ command: "channel:set", cwd });

    expect(mocks.warn).toHaveBeenCalledWith("Expo CNG project detected.");
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("npx expo prebuild"),
    );
  });

  it("does not emit native mutation guidance for deployment", async () => {
    const cwd = await createProject({ dependencies: {} }, { expo: {} });

    validateExpoProject({ command: "deploy", cwd });

    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
