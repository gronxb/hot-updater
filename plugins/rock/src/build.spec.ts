import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock("execa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("execa")>()),
  execa: mocks.execa,
}));

import { rock } from "./index";

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rock-artifacts-"));
  mocks.execa.mockReset().mockImplementation(async (_command, args) => {
    const output = args[args.indexOf("--bundle-output") + 1];
    await fs.writeFile(output, "javascript");
    await fs.writeFile(`${output}.map`, "source map");
    await fs.mkdir(path.join(path.dirname(output), "assets"));
    await fs.writeFile(
      path.join(path.dirname(output), "assets/logo.png"),
      "image",
    );
    if (args.includes("--hermes")) {
      await fs.writeFile(`${output}.hbc`, "bytecode");
    }
    return { stdout: "bundled" };
  });
});
afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

it.each([
  ["ios", true],
  ["ios", false],
  ["android", true],
  ["android", false],
] as const)(
  "declares %s artifacts with Hermes=%s",
  async (platform, hermes) => {
    const result = await rock({ hermes })({ cwd }).build({ platform });

    expect(result.patchAssetPath).toBe(`index.${platform}.bundle`);
    expect(result.artifacts).toEqual([
      {
        path: path.join(cwd, "dist/assets/logo.png"),
        name: "assets/logo.png",
        downloadCompression: null,
      },
      {
        path: path.join(
          cwd,
          `dist/index.${platform}.bundle${hermes ? ".hbc" : ""}`,
        ),
        name: `index.${platform}.bundle`,
        downloadCompression: "br",
      },
    ]);
    expect(mocks.execa).toHaveBeenCalledWith(
      "npx",
      expect.arrayContaining(["rock", "bundle", "--platform", platform]),
      expect.objectContaining({ cwd }),
    );
  },
);
