import fs from "fs/promises";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  zipSize: undefined as number | undefined,
  zipped: [] as string[],
}));

vi.mock("@hot-updater/cli-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-updater/cli-tools")>();
  return {
    ...actual,
    // Zips as the CLI does, or writes a zip of the size a test sets.
    createZip: vi.fn(
      async (options: { outfile: string; targetDir: string }) => {
        mocks.zipped.push(options.targetDir);
        if (mocks.zipSize === undefined) return actual.createZip(options);
        await fs.writeFile(options.outfile, "");
        await fs.truncate(options.outfile, mocks.zipSize);
      },
    ),
  };
});

import { InitError } from "@hot-updater/cli-tools";

import { LAMBDA_EDGE_MAX_ZIP_BYTES, stageLambda } from "./lambdaEdge";
import { getConfigScaffold } from "./templates";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** The definition init writes, with a plugin of the project's own. */
const withNotes = (text: string) =>
  text
    .replace(
      'import { createHotUpdater } from "@hot-updater/server";',
      `import { createHotUpdater } from "@hot-updater/server";
import { definePlugin } from "@hot-updater/plugin-core";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({ from: "the project's plugin" }),
      },
    ],
  }),
});`,
    )
    .replace("  plugins,\n", "  plugins: [...plugins, notes],\n");

let root: string;

/** A project whose hotUpdater.ts is `text`, as init's working directory. */
const project = async (text: string) => {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app" }),
  );
  await fs.mkdir(path.join(root, "node_modules", "@hot-updater"), {
    recursive: true,
  });
  await fs.symlink(
    packageRoot,
    path.join(root, "node_modules", "@hot-updater", "aws"),
  );
  await fs.symlink(
    path.join(packageRoot, "node_modules", "@hot-updater", "server"),
    path.join(root, "node_modules", "@hot-updater", "server"),
  );
  await fs.symlink(
    path.join(packageRoot, "node_modules", "@hot-updater", "plugin-core"),
    path.join(root, "node_modules", "@hot-updater", "plugin-core"),
  );
  const definition = path.join(root, "hotUpdater.ts");
  await fs.writeFile(definition, text);
  return definition;
};

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-stage-")),
  );
  vi.spyOn(process, "cwd").mockReturnValue(root);
  mocks.zipSize = undefined;
  mocks.zipped = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("stageLambda", () => {
  it("stages the prebuilt function when the definition is init's", async () => {
    const staged = await stageLambda(undefined);
    try {
      await expect(
        fs.readFile(path.join(staged.dir, "index.cjs"), "utf-8"),
      ).resolves.toContain("HotUpdater.DYNAMODB_TABLE_NAME");
    } finally {
      await staged.remove();
    }
    expect(await exists(staged.dir)).toBe(false);
  });

  it("bundles an edited definition, checks its zip, and leaves only the code", async () => {
    const definition = await project(
      withNotes(getConfigScaffold("bare", { mode: "account" }).definition.text),
    );

    const staged = await stageLambda(definition);
    try {
      expect(await fs.readdir(staged.dir)).toEqual(["index.cjs"]);
      const code = await fs.readFile(
        path.join(staged.dir, "index.cjs"),
        "utf-8",
      );
      expect(code).toContain("the project's plugin");
      expect(code).not.toContain(root);
      // The zip that checked the size is gone; deploy zips the code again.
      expect(mocks.zipped).toEqual([staged.dir]);
      expect(await exists(`${staged.dir}.zip`)).toBe(false);
    } finally {
      await staged.remove();
    }
  });

  it("refuses a definition whose code zips past Lambda@Edge's limit, and removes what it staged", async () => {
    const definition = await project(
      getConfigScaffold("bare", { mode: "account" }).definition.text.replace(
        "  plugins,\n",
        "  plugins: [...plugins],\n",
      ),
    );
    mocks.zipSize = LAMBDA_EDGE_MAX_ZIP_BYTES + 1;

    const staging = stageLambda(definition);

    await expect(staging).rejects.toBeInstanceOf(InitError);
    await expect(staging).rejects.toThrow(
      "hotUpdater.ts bundles into a Lambda@Edge function that zips to 50.0 MB, over Lambda@Edge's 50.0 MB limit for origin-request functions. Remove large dependencies from its plugins, or host the server yourself.",
    );
    const [dir] = mocks.zipped;
    expect(await exists(dir!)).toBe(false);
    expect(await exists(`${dir}.zip`)).toBe(false);
  });

  it("refuses a definition it cannot bundle, and removes what it staged", async () => {
    const definition = await project(
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );
    const mkdtemp = vi.spyOn(fs, "mkdtemp");

    const staging = stageLambda(definition);

    await expect(staging).rejects.toBeInstanceOf(InitError);
    await expect(staging).rejects.toThrow(
      /^Could not bundle hotUpdater\.ts into the AWS Lambda@Edge function: .*Could not resolve "@acme\/missing-plugin"/su,
    );
    const dir = await mkdtemp.mock.results[0]!.value;
    expect(await exists(dir)).toBe(false);
    expect(mocks.zipped).toEqual([]);
  });
});
