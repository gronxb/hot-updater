import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compileHermes: vi.fn(),
  execa: vi.fn(),
}));

vi.mock("@hot-updater/bare", () => ({ compileHermes: mocks.compileHermes }));
vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: mocks.execa,
}));

import { expo } from "./expo";

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

async function createProject(files: Record<string, string>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "expo-build-config-"));
  tempDirs.push(cwd);
  await fs.mkdir(path.join(cwd, "node_modules"));
  await fs.symlink(
    path.dirname(require.resolve("expo/package.json")),
    path.join(cwd, "node_modules/expo"),
    "junction",
  );
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "test-app", version: "1.0.0", main: "index.js" }),
  );
  await fs.writeFile(path.join(cwd, "index.js"), "");
  for (const [name, source] of Object.entries(files)) {
    await fs.writeFile(path.join(cwd, name), source);
  }
  return cwd;
}

beforeEach(() => {
  mocks.execa.mockReset().mockResolvedValue({ stdout: "exported" });
  mocks.compileHermes
    .mockReset()
    .mockResolvedValue({ hermesVersion: "Hermes" });
});

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("Expo build engine from evaluated config", () => {
  it.each(["js", "ts"])(
    "uses JSC from app.config.%s without app.json",
    async (extension) => {
      const cwd = await createProject({
        [`app.config.${extension}`]:
          'module.exports = { name: "app", slug: "app", jsEngine: "jsc" };',
      });

      await expo()({ cwd }).build({ platform: "ios" });

      expect(mocks.execa).toHaveBeenCalledWith(
        "npx",
        expect.arrayContaining(["--minify", "true"]),
        expect.objectContaining({ cwd }),
      );
      expect(mocks.compileHermes).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ios", false],
    ["android", true],
  ] as const)(
    "honors dynamic platform overrides for %s",
    async (platform, enableHermes) => {
      const cwd = await createProject({
        "app.json": JSON.stringify({
          expo: { name: "app", slug: "app", jsEngine: "hermes" },
        }),
        "app.config.js":
          'module.exports = ({ config }) => ({ ...config, jsEngine: "jsc", android: { jsEngine: "hermes" } });',
      });

      await expo()({ cwd }).build({ platform });

      expect(mocks.execa).toHaveBeenCalledWith(
        "npx",
        expect.arrayContaining(["--minify", String(!enableHermes)]),
        expect.objectContaining({ cwd }),
      );
      expect(mocks.compileHermes).toHaveBeenCalledTimes(enableHermes ? 1 : 0);
    },
  );

  it("defaults to Hermes when the evaluated config has no engine", async () => {
    const cwd = await createProject({
      "app.config.js": 'module.exports = { name: "app", slug: "app" };',
    });

    await expo()({ cwd }).build({ platform: "ios" });

    expect(mocks.compileHermes).toHaveBeenCalledWith({
      cwd,
      inputJsFile: path.join(cwd, "dist/index.ios.bundle"),
      sourcemap: false,
    });
  });

  it("propagates config errors before exporting or compiling a bundle", async () => {
    const cwd = await createProject({
      "app.config.js": 'throw new Error("invalid dynamic config");',
    });

    await expect(expo()({ cwd }).build({ platform: "ios" })).rejects.toThrow(
      "invalid dynamic config",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
    expect(mocks.compileHermes).not.toHaveBeenCalled();
  });
});

describe("Expo SDK floor", () => {
  it("refuses a build on an SDK below 55, before bundling", async () => {
    const cwd = await createProject({});
    // The real expo package, reporting SDK 54.
    const real = await fs.realpath(path.join(cwd, "node_modules/expo"));
    await fs.rm(path.join(cwd, "node_modules/expo"));
    await fs.mkdir(path.join(cwd, "node_modules/expo"));
    for (const entry of await fs.readdir(real)) {
      if (entry === "package.json") continue;
      await fs.symlink(
        path.join(real, entry),
        path.join(cwd, "node_modules/expo", entry),
      );
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(real, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    await fs.writeFile(
      path.join(cwd, "node_modules/expo/package.json"),
      JSON.stringify({ ...manifest, version: "54.0.38" }),
    );

    await expect(expo()({ cwd }).build({ platform: "ios" })).rejects.toThrow(
      "Hot Updater requires Expo SDK 55 or later. Run:\nnpx expo install expo@^55.0.0 --fix",
    );
    expect(mocks.execa).not.toHaveBeenCalled();
  });
});
