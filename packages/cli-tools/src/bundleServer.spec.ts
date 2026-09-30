import fs from "fs/promises";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleServer } from "./bundleServer";
import { InitError } from "./initOptions";

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
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
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
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
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
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
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
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
      outfile: path.join(root, "out/index.mjs"),
      format: "esm",
      platform: "neutral",
      define: { "HotUpdater.BUCKET_NAME": JSON.stringify("bundles") },
      banner: "globalThis.process ??= { env: {} };",
      target: "a test server",
    });

    const code = await fs.readFile(path.join(root, "out/index.mjs"), "utf-8");
    expect(code).toContain("globalThis.process ??= { env: {} };");
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
        definition: path.join(root, "entry.ts"),
        projectRoot: root,
        outfile: path.join(root, "out/index.cjs"),
        format: "cjs",
        platform: "node",
        target: "a test server",
      }),
    ).rejects.toThrow(
      "Could not bundle entry.ts into a test server: it would include two copies of @hot-updater/server: 1.0.0 (node_modules/@hot-updater/server) and 0.9.0 (node_modules/plugin-x/node_modules/@hot-updater/server). Install the version your provider package uses, so the plugins run on the same server.",
    );
  });

  it("keeps the machine's paths out of the bundle, and names the definition when it fails", async () => {
    await write(
      "entry.ts",
      'import { notes } from "./server/notes";\nexport const plugins = [notes];\n',
    );
    const outfile = path.join(root, "out/index.cjs");

    await bundleServer({
      input: path.join(root, "entry.ts"),
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
      outfile,
      format: "cjs",
      platform: "node",
      target: "a test server",
    });

    const code = await fs.readFile(outfile, "utf-8");
    expect(code).toContain("// server/notes.ts");
    expect(code).not.toContain(root);
    expect(code).not.toContain(os.homedir());

    await write(
      "broken.ts",
      'import { gone } from "@acme/missing";\nexport default gone;\n',
    );
    const failure = bundleServer({
      input: path.join(root, "broken.ts"),
      definition: path.join(root, "broken.ts"),
      projectRoot: root,
      outfile,
      format: "cjs",
      platform: "node",
      target: "a test server",
    });
    await expect(failure).rejects.toBeInstanceOf(InitError);
    await expect(failure).rejects.toThrow(
      /^Could not bundle broken\.ts into a test server: .*@acme\/missing/su,
    );
  });

  it("bundles an npm package named like a built-in that Node only has behind node:", async () => {
    await pkg(
      "node_modules/sqlite",
      "sqlite",
      "export const open = () => 'the npm sqlite';\n",
    );
    await write(
      "entry.ts",
      'import { open } from "sqlite";\nimport { DatabaseSync } from "node:sqlite";\nexport const both = [open(), DatabaseSync];\n',
    );
    const outfile = path.join(root, "out/index.mjs");

    await bundleServer({
      input: path.join(root, "entry.ts"),
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
      outfile,
      format: "esm",
      platform: "neutral",
      target: "a test server",
    });

    const code = await fs.readFile(outfile, "utf-8");
    expect(code).toContain("the npm sqlite");
    expect(code).toMatch(/from "node:sqlite"/u);
  });

  it("lets a CommonJS dependency require a built-in on a runtime that is not Node", async () => {
    await pkg(
      "node_modules/cjs-hash",
      "cjs-hash",
      'const crypto = require("node:crypto");\nconst EventEmitter = require("events");\nexports.hash = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);\nexports.emits = () => typeof new EventEmitter().on === "function";\n',
    );
    // A module that imports process itself, beside the definition's banner.
    await write(
      "server/env.ts",
      'import process from "node:process";\nexport const mode = process.env.HOT_UPDATER_BUNDLE_SPEC ?? "unset";\n',
    );
    await write(
      "entry.ts",
      'import { hash, emits } from "cjs-hash";\nimport { mode } from "./server/env";\nexport const result = { hash: hash("x"), emits: emits(), mode };\n',
    );
    const outfile = path.join(root, "out/index.mjs");

    await bundleServer({
      input: path.join(root, "entry.ts"),
      definition: path.join(root, "entry.ts"),
      projectRoot: root,
      outfile,
      format: "esm",
      platform: "neutral",
      banner: "globalThis.process ??= { env: {} };",
      target: "a test server",
    });

    const { result } = (await import(pathToFileURL(outfile).href)) as {
      result: unknown;
    };
    expect(result).toEqual({ hash: "2d711642", emits: true, mode: "unset" });
  });
});
