import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const osBin =
  process.platform === "win32"
    ? "win64-bin"
    : process.platform === "darwin"
      ? "osx-bin"
      : "linux64-bin";
const executable = process.platform === "win32" ? "hermesc.exe" : "hermesc";

async function writeFile(file: string, contents = "") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("getHermesCommand project resolution", () => {
  it.each(["hermes-compiler", "bundled"] as const)(
    "resolves %s from the app's hoisted dependencies",
    async (selected) => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "hermes-resolution-"),
      );
      tempDirs.push(root);
      const cwd = path.join(root, "apps/mobile");
      await fs.mkdir(cwd, { recursive: true });
      const nodeModules = path.join(root, "node_modules");
      await writeFile(
        path.join(nodeModules, "react-native/package.json"),
        JSON.stringify({
          name: "react-native",
          version: "0.85.2",
          main: "index.js",
        }),
      );
      await writeFile(path.join(nodeModules, "react-native/index.js"));
      const binaries = {
        "hermes-compiler": path.join(
          nodeModules,
          "hermes-compiler/hermesc",
          osBin,
          executable,
        ),
        bundled: path.join(
          nodeModules,
          "react-native/sdks/hermesc",
          osBin,
          executable,
        ),
        "hermes-engine": path.join(
          nodeModules,
          "hermes-engine",
          osBin,
          executable,
        ),
        hermesvm: path.join(nodeModules, "hermesvm", osBin, "hermes"),
      };
      const order = [
        "hermes-compiler",
        "bundled",
        "hermes-engine",
        "hermesvm",
      ] as const;
      for (const engine of order.slice(order.indexOf(selected))) {
        await writeFile(binaries[engine]);
      }
      if (selected === "hermes-compiler") {
        await writeFile(
          path.join(nodeModules, "hermes-compiler/package.json"),
          JSON.stringify({ name: "hermes-compiler" }),
        );
      }

      // Keep pnpm's test-runner NODE_PATH out of the app's resolution.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { getHermesCommand } from ${JSON.stringify(new URL("../dist/index.mjs", import.meta.url).href)}; console.log(await getHermesCommand(${JSON.stringify(cwd)}));`,
        ],
        { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(await fs.realpath(binaries[selected]));
    },
  );

  it.each(["hermes-engine", "hermesvm"] as const)(
    "preserves the legacy %s path fallback",
    async (selected) => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-legacy-"));
      tempDirs.push(cwd);
      await writeFile(
        path.join(cwd, "node_modules/react-native/package.json"),
        JSON.stringify({ name: "react-native", version: "0.68.0" }),
      );
      const binary = path.join(
        "node_modules",
        selected,
        osBin,
        selected === "hermes-engine" ? executable : "hermes",
      );
      if (selected === "hermes-engine") {
        await writeFile(path.join(cwd, binary));
        await writeFile(
          path.join(cwd, "node_modules/hermes-engine/package.json"),
          JSON.stringify({ name: "hermes-engine", exports: {} }),
        );
      }

      // The final hermesvm fallback returns its path even without a binary.
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { getHermesCommand } from ${JSON.stringify(new URL("../dist/index.mjs", import.meta.url).href)}; console.log(await getHermesCommand(${JSON.stringify(cwd)}));`,
        ],
        { cwd, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(binary);
    },
  );
});
