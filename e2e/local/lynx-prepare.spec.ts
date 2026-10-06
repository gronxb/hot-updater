import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { publishedBin } from "../shared/published.ts";
import { lynxLocalMutableFiles } from "./files.ts";
import { runLocal } from "./prepare.ts";

vi.mock("../shared/published.ts", () => ({ publishedBin: vi.fn() }));

describe("local Lynx preparation", () => {
  it("restores native trust configuration and caller keys after a native build failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hu-local-lynx-"));
    const app = path.join(root, "examples/lynx");
    const bin = path.join(root, "bin");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fs.mkdir(bin);
      const originals = new Map<string, Buffer>();
      for (const name of lynxLocalMutableFiles) {
        if (name === ".gitignore") continue;
        const file = path.join(app, name);
        const bytes = Buffer.from("original " + name + "\r\n");
        originals.set(name, bytes);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes, { mode: 0o640 });
      }
      const writeTool = async (name: string, source: string) =>
        fs.writeFile(
          path.join(bin, name),
          "#!" + process.execPath + "\n" + source,
          { mode: 0o755 },
        );
      await writeTool(
        "adb",
        'console.log("List of devices attached\\nemulator-5598 device");',
      );
      await writeTool("java", "process.exit(0);");
      await writeTool(
        "pnpm",
        'if (process.argv.slice(2).join(" ") !== "-w build") process.exit(2);',
      );
      await writeTool(
        "docker",
        [
          'if (process.argv[2] === "info") process.exit(0);',
          'if (process.argv[2] === "inspect") { console.error("No such object"); process.exit(1); }',
          "process.exit(2);",
        ].join("\n"),
      );
      const cli = path.join(root, "cli.mjs");
      vi.mocked(publishedBin).mockReturnValue(cli);
      const nativeFiles = lynxLocalMutableFiles.filter(
        (name) =>
          name.endsWith("Info.plist") || name.endsWith("AndroidManifest.xml"),
      );
      await fs.writeFile(
        cli,
        [
          'import fs from "node:fs"; import path from "node:path";',
          "const args = process.argv.slice(2);",
          'if (args[0] !== "keys") throw new Error("Unexpected fingerprint or provider command");',
          'if (args[1] === "generate") {',
          '  const dir = args[args.indexOf("--output") + 1];',
          "  fs.mkdirSync(dir, { recursive: true });",
          '  for (const name of ["private-key.pem", "public-key.pem"]) fs.writeFileSync(path.join(dir, name), "temporary key");',
          '} else if (args[1] === "export-public") {',
          "  for (const name of " +
            JSON.stringify(nativeFiles) +
            ') fs.writeFileSync(name, "injected native public key");',
          '  fs.writeFileSync(".gitignore", "keys");',
          '} else throw new Error("Unexpected key operation");',
        ].join("\n"),
      );
      const build = path.join(app, "scripts/build-e2e-native.mjs");
      await fs.mkdir(path.dirname(build), { recursive: true });
      const reached = path.join(root, "native-build-reached");
      await fs.writeFile(
        build,
        [
          'import fs from "node:fs";',
          'if (process.argv.slice(2).join(" ") !== "--platform android --target e2e") throw new Error("Wrong build target");',
          'if (fs.readFileSync("hot-updater.config.ts", "utf8") !== "original hot-updater.config.ts\\r\\n") throw new Error("Lynx adapter was overwritten");',
          'if (fs.readFileSync("android/e2e-app/src/main/AndroidManifest.xml", "utf8") !== "injected native public key") throw new Error("Missing trust configuration");',
          "fs.writeFileSync(" + JSON.stringify(reached) + ', "yes");',
          "process.exit(42);",
        ].join("\n"),
      );
      await expect(
        runLocal(
          ["--platform", "android", "--runtime", "lynx"],
          root,
          "android",
          "emulator-5598",
          { ...process.env, PATH: bin },
          "lynx",
        ),
      ).rejects.toThrow("failed (42)");
      expect(await fs.readFile(reached, "utf8")).toBe("yes");
      for (const [name, bytes] of originals) {
        const file = path.join(app, name);
        expect(await fs.readFile(file), name).toEqual(bytes);
        expect((await fs.stat(file)).mode & 0o777, name).toBe(0o640);
      }
      for (const file of [
        path.join(app, ".gitignore"),
        path.join(root, "e2e/results/local/checkout.lock"),
        path.join(root, "examples/v0.85.0"),
      ])
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      log.mockRestore();
      vi.mocked(publishedBin).mockReset();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
