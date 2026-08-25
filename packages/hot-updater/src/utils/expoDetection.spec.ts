import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { isExpo } from "./expoDetection";

const temporaryDirectories: string[] = [];

const createProject = async (packageJson: Record<string, unknown>) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "hot-updater-expo-"));
  temporaryDirectories.push(workspace);

  const projectPath = path.join(workspace, "app");
  await mkdir(projectPath);
  await writeFile(
    path.join(projectPath, "package.json"),
    JSON.stringify(packageJson),
  );
  return { projectPath, workspace };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("isExpo", () => {
  it("detects Expo from the target app dependencies", async () => {
    const { projectPath } = await createProject({
      dependencies: { expo: "^52.0.0" },
    });

    expect(isExpo(projectPath)).toBe(true);
  });

  it("ignores Expo installed for another workspace package", async () => {
    const { projectPath, workspace } = await createProject({
      dependencies: { "react-native": "0.85.2" },
    });
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ dependencies: { expo: "^52.0.0" } }),
    );

    expect(isExpo(projectPath)).toBe(false);
  });
});
