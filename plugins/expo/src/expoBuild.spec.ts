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
  mocks.execa.mockReset().mockImplementation(async (_command, args) => {
    const output = args[args.indexOf("--bundle-output") + 1];
    if (args.includes("--bundle-output"))
      await fs.writeFile(output, "javascript");
    return { stdout: "exported" };
  });
  mocks.compileHermes
    .mockReset()
    .mockImplementation(async ({ inputJsFile }: { inputJsFile: string }) => {
      await fs.writeFile(`${inputJsFile}.hbc`, "bytecode");
      return { hermesVersion: "Hermes" };
    });
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

      const result = await expo()({ cwd }).build({ platform });

      expect(result.patchAssetPath).toBe(`index.${platform}.bundle`);
      expect(result.artifacts).toEqual([
        {
          name: `index.${platform}.bundle`,
          path: path.join(
            cwd,
            `dist/index.${platform}.bundle${enableHermes ? ".hbc" : ""}`,
          ),
          downloadCompression: "br",
        },
      ]);

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
