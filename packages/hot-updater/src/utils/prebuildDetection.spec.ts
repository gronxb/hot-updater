import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { stripVTControlCharacters } from "node:util";
import { tmpdir } from "os";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isExpo, warnIfPrebuildGenerated } from "./prebuildDetection";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: vi.fn(() => process.cwd()),
}));

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

describe("warnIfPrebuildGenerated", () => {
  // An Expo CNG project: the expo package and app.json, no native folders.
  const createCngProject = async () => {
    const { projectPath } = await createProject({
      dependencies: { expo: "^55.0.0" },
    });
    await writeFile(
      path.join(projectPath, "app.json"),
      JSON.stringify({ expo: { name: "app" } }),
    );
    // The CLI runs in the project.
    vi.mocked(getCwd).mockReturnValue(projectPath);
    return projectPath;
  };
  // A build adapter that reads the Expo config, as @hot-updater/expo does:
  // a channel only when the config lists the config plugin.
  const configListing = (listsPlugin: boolean, publicKeyPath?: string) => ({
    build: async () => ({
      name: "expo",
      build: vi.fn(),
      nativeBuild: {
        getNativeProjectValues: async () =>
          listsPlugin
            ? {
                channel: "production",
                ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
              }
            : {},
      },
    }),
  });
  const printed = async (run: () => Promise<unknown>) => {
    let output = "";
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });
    try {
      await run();
    } finally {
      write.mockRestore();
    }
    return stripVTControlCharacters(output);
  };

  it("prints nothing when the Expo config lists @hot-updater/expo", async () => {
    const cwd = await createCngProject();

    const output = await printed(() =>
      warnIfPrebuildGenerated({ cwd, config: configListing(true) }),
    );

    expect(output).toBe("");
  });

  it("prints the config plugin entry intact when the Expo config doesn't list it", async () => {
    const cwd = await createCngProject();

    const output = await printed(() =>
      warnIfPrebuildGenerated({ cwd, config: configListing(false) }),
    );

    expect(output).toContain(
      "Expo CNG project: npx expo prebuild regenerates the native files.",
    );
    expect(output).toContain(
      '"plugins": [["@hot-updater/expo", { "channel": "production" }]]',
    );
  });

  describe("before keys export-public writes the key into the native files", () => {
    const keyWarning =
      "Expo CNG project: npx expo prebuild removes this key. Export it with --output and set publicKeyPath in the @hot-updater/expo plugin:";
    const keySnippet = [
      '│  "plugins": [["@hot-updater/expo", {',
      '│    "channel": "production",',
      '│    "publicKeyPath": "./keys/public-key.pem"',
      "│  }]]",
    ].join("\n");

    it.each([
      ["doesn't list the config plugin", configListing(false)],
      ["lists it without publicKeyPath", configListing(true)],
    ])(
      "warns that prebuild removes the key when the Expo config %s",
      async (_, config) => {
        const cwd = await createCngProject();

        const output = await printed(() =>
          warnIfPrebuildGenerated({ cwd, config, publicKey: true }),
        );

        expect(output.replace(/\n│ {2}/g, " ")).toContain(keyWarning);
        expect(output).toContain(keySnippet);
      },
    );

    it("prints nothing when the config plugin sets publicKeyPath", async () => {
      const cwd = await createCngProject();

      const output = await printed(() =>
        warnIfPrebuildGenerated({
          cwd,
          config: configListing(true, "./keys/public-key.pem"),
          publicKey: true,
        }),
      );

      expect(output).toBe("");
    });
  });

  describe("in a One app", () => {
    const createOneApp = async () => {
      const { projectPath } = await createProject({
        dependencies: { one: "^2.15.0" },
      });
      await writeFile(path.join(projectPath, "vite.config.ts"), "");
      vi.mocked(getCwd).mockReturnValue(projectPath);
      return projectPath;
    };

    it("prints nothing when native.app.patches has hotUpdaterPatches", async () => {
      const cwd = await createOneApp();

      const output = await printed(() =>
        warnIfPrebuildGenerated({ cwd, config: configListing(true) }),
      );

      expect(output).toBe("");
    });

    it("prints the hotUpdaterPatches entry when native.app.patches doesn't have it", async () => {
      const cwd = await createOneApp();

      const output = await printed(() =>
        warnIfPrebuildGenerated({ cwd, config: configListing(false) }),
      );

      expect(output).toContain(
        "One app: npx one prebuild regenerates the native files.",
      );
      expect(output).toContain(
        'patches: hotUpdaterPatches({ channel: "production" })',
      );
    });

    it("warns that prebuild removes the key without publicKeyPath", async () => {
      const cwd = await createOneApp();

      const output = await printed(() =>
        warnIfPrebuildGenerated({
          cwd,
          config: configListing(true),
          publicKey: true,
        }),
      );

      expect(output.replace(/\n│ {2}/g, " ")).toContain(
        "One app: npx one prebuild removes this key. Export it with --output and set publicKeyPath in hotUpdaterPatches:",
      );
      expect(output).toContain('│    publicKeyPath: "./keys/public-key.pem",');
    });

    it("returns the publicKeyPath hotUpdaterPatches sets", async () => {
      const cwd = await createOneApp();

      await expect(
        warnIfPrebuildGenerated({
          cwd,
          config: configListing(true, "./keys/public-key.pem"),
          publicKey: true,
        }),
      ).resolves.toEqual({
        command: "npx one prebuild",
        publicKeyPath: "./keys/public-key.pem",
      });
    });
  });
});
