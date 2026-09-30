import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleServer } from "./bundleServer";

let root: string;

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text, "utf-8");
};

/** A package in the project's node_modules, or nested in another's. */
const pkg = async (directory: string, name: string, source: string) => {
  await write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      version: directory.includes("plugin") ? "0.9.0" : "1.0.0",
      main: "index.js",
    }),
  );
  await write(path.join(directory, "index.js"), source);
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-bundle-"));
  await pkg(
    "node_modules/@hot-updater/server",
    "@hot-updater/server",
    "export const createHotUpdater = () => 'server';\n",
  );
  await write(
    "server/notes.ts",
    'import { readFileSync } from "fs";\nexport const notes = { id: "notes", read: readFileSync };\n',
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("bundleServer", () => {
  it("bundles the entry, its local modules, and its dependencies into one file", async () => {
    await write(
      "entry.ts",
      'import { createHotUpdater } from "@hot-updater/server";\nimport { notes } from "./server/notes";\nexport const handler = [createHotUpdater(), notes.id];\n',
    );
    const outfile = path.join(root, "out/index.cjs");

    const { bytes } = await bundleServer({
      input: path.join(root, "entry.ts"),
      outfile,
      format: "cjs",
      platform: "node",
      target: "a test server",
    });

    const code = await fs.readFile(outfile, "utf-8");
    expect(bytes).toBe(Buffer.byteLength(code));
    expect(code).toMatch(/["']server["']/u);
    expect(code).toContain('"notes"');
    expect(code).toMatch(/require\("fs"\)/u);
  });

  it("leaves Node's built-ins as node: imports for a runtime that is not Node", async () => {
    await write(
      "entry.ts",
      'import { notes } from "./server/notes";\nexport const plugins = [notes];\n',
    );
    const outfile = path.join(root, "out/index.mjs");

    await bundleServer({
      input: path.join(root, "entry.ts"),
      outfile,
      format: "esm",
      platform: "neutral",
      conditions: ["deno", "worker"],
      target: "a test server",
    });

    expect(await fs.readFile(outfile, "utf-8")).toMatch(/from "node:fs"/u);
  });

  it("replaces exact imports: a path is bundled, and a name stays an import", async () => {
    await write(
      "worker.js",
      'export const plugins = ["from the worker entry"];\n',
    );
    await write(
      "entry.ts",
      'import { plugins } from "provider";\nimport { edge } from "provider-edge";\nimport { sub } from "provider/sub";\nexport const all = [plugins, edge, sub];\n',
    );
    const outfile = path.join(root, "out/index.mjs");

    await bundleServer({
      input: path.join(root, "entry.ts"),
      outfile,
      format: "esm",
      platform: "neutral",
      external: ["provider/sub"],
      alias: {
        provider: path.join(root, "worker.js"),
        "provider-edge": "provider/edge",
      },
      target: "a test server",
    });

    const code = await fs.readFile(outfile, "utf-8");
    expect(code).toContain("from the worker entry");
    expect(code).toMatch(/from "provider\/edge"/u);
    expect(code).toMatch(/from "provider\/sub"/u);
  });

  it("replaces defined expressions and puts the banner first", async () => {
    await write(
      "entry.ts",
      "export const bucket = HotUpdater.BUCKET_NAME;\nexport const env = process.env.SECRET;\n",
    );

    await bundleServer({
      input: path.join(root, "entry.ts"),
      outfile: path.join(root, "out/index.mjs"),
      format: "esm",
      platform: "neutral",
      define: { "HotUpdater.BUCKET_NAME": JSON.stringify("bundles") },
      banner: "const process = globalThis.process ?? { env: {} };",
      target: "a test server",
    });

    const code = await fs.readFile(path.join(root, "out/index.mjs"), "utf-8");
    expect(code.startsWith("const process = globalThis.process")).toBe(true);
    expect(code).toContain('"bundles"');
    expect(code).not.toContain("HotUpdater.BUCKET_NAME");
  });

  it("refuses a second copy of @hot-updater/server, naming both", async () => {
    await pkg(
      "node_modules/plugin-x/node_modules/@hot-updater/server",
      "@hot-updater/server",
      "export const createHotUpdater = () => 'other';\n",
    );
    await pkg(
      "node_modules/plugin-x",
      "plugin-x",
      'export { createHotUpdater as other } from "@hot-updater/server";\n',
    );
    await write(
      "entry.ts",
      'import { createHotUpdater } from "@hot-updater/server";\nimport { other } from "plugin-x";\nexport const handler = [createHotUpdater(), other()];\n',
    );

    await expect(
      bundleServer({
        input: path.join(root, "entry.ts"),
        outfile: path.join(root, "out/index.cjs"),
        format: "cjs",
        platform: "node",
        target: "a test server",
      }),
    ).rejects.toThrow(
      /Could not build a test server with .*entry\.ts: it would include two copies of @hot-updater\/server: 1\.0\.0 \(.*\) and 0\.9\.0 \(.*\)\./u,
    );
  });
});
