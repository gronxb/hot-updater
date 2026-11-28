import fs from "fs";
import os from "os";
import path from "path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractBuiltInBundle } from "./extractBuiltInBundle";

vi.mock("execa", () => ({ execa: vi.fn() }));

describe("extractBuiltInBundle", () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "built-in-"));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("copies main.jsbundle out of a .app", async () => {
    const appPath = path.join(dir, "App.app");
    await fs.promises.mkdir(appPath);
    await fs.promises.writeFile(
      path.join(appPath, "main.jsbundle"),
      "hermes bytecode",
    );
    const outputPath = path.join(dir, "out", "index.ios.bundle");

    await extractBuiltInBundle({ artifactPath: appPath, outputPath });

    await expect(fs.promises.readFile(outputPath, "utf8")).resolves.toBe(
      "hermes bytecode",
    );
  });

  it("refuses a .app without main.jsbundle", async () => {
    const appPath = path.join(dir, "App.app");
    await fs.promises.mkdir(appPath);

    await expect(
      extractBuiltInBundle({
        artifactPath: appPath,
        outputPath: path.join(dir, "index.ios.bundle"),
      }),
    ).rejects.toThrow("App.app has no main.jsbundle");
  });

  it("unzips Payload/<App>.app/main.jsbundle out of an .ipa", async () => {
    vi.mocked(execa).mockResolvedValueOnce({
      stdout: [
        "Payload/",
        "Payload/My App.app/",
        "Payload/My App.app/Frameworks/main.jsbundle",
        "Payload/My App.app/main.jsbundle",
      ].join("\n"),
    } as never);
    vi.mocked(execa).mockResolvedValueOnce({} as never);
    const outputPath = path.join(dir, "index.ios.bundle");

    await extractBuiltInBundle({
      artifactPath: path.join(dir, "App.ipa"),
      outputPath,
    });

    expect(execa).toHaveBeenLastCalledWith(
      "unzip",
      ["-p", path.join(dir, "App.ipa"), "Payload/My App.app/main.jsbundle"],
      { stdout: { file: outputPath } },
    );
  });
});
