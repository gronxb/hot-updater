import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { getPrebuildFramework, isExpo, isOne } from "./prebuildDetection";

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

describe("isOne", () => {
  it("detects a One app from its dependency and vite config", async () => {
    const { projectPath } = await createProject({
      dependencies: { one: "2.8.1" },
    });
    await writeFile(path.join(projectPath, "vite.config.ts"), "");

    expect(isOne(projectPath)).toBe(true);
  });

  it("ignores a One dependency without a vite config", async () => {
    const { projectPath } = await createProject({
      dependencies: { one: "2.8.1" },
    });

    expect(isOne(projectPath)).toBe(false);
  });
});

describe("getPrebuildFramework", () => {
  it("names One for a One app", async () => {
    const { projectPath } = await createProject({
      dependencies: { one: "2.8.1" },
    });
    await writeFile(path.join(projectPath, "vite.config.mts"), "");

    expect(getPrebuildFramework(projectPath)).toBe("one");
  });

  it("names Expo for an Expo CNG project", async () => {
    const { projectPath } = await createProject({
      dependencies: { expo: "^52.0.0" },
    });
    await writeFile(
      path.join(projectPath, "app.json"),
      JSON.stringify({ expo: { name: "app" } }),
    );

    expect(getPrebuildFramework(projectPath)).toBe("expo");
  });

  it("names nothing for a bare React Native app", async () => {
    const { projectPath } = await createProject({
      dependencies: { "react-native": "0.85.2" },
    });

    expect(getPrebuildFramework(projectPath)).toBeNull();
  });
});
