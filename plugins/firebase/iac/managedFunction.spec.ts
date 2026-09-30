import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFunctionFromDefinition } from "./managedFunction";

const packageRoot = path.resolve(import.meta.dirname, "..");

/** A project's server definition, as init writes it, with a plugin of its own. */
const DEFINITION = `import {
  firebaseDatabase,
  firebaseStorage,
  plugins,
} from "@hot-updater/firebase";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/server/plugins";
import { applicationDefault } from "firebase-admin/app";

const notes = definePlugin({
  id: "notes",
  schemaVersion: "1",
  schema: {
    notes: defineTable(
      { id: { type: "string" }, text: { type: "string" } },
      { key: ["id"] },
    ),
  },
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/notes/:id",
        access: "client",
        handler: async () => Response.json({ from: "sample notes plugin" }),
      },
    ],
  }),
});

const credential = applicationDefault();

export const hotUpdater = createHotUpdater({
  database: firebaseDatabase({
    projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
    credential,
  }),
  storage: [
    firebaseStorage({
      projectId: process.env.HOT_UPDATER_FIREBASE_PROJECT_ID!,
      storageBucket: process.env.HOT_UPDATER_FIREBASE_STORAGE_BUCKET!,
      credential,
    }),
  ],
  plugins: [...plugins, notes],
});
`;

let project: string;
let functionsDir: string;

beforeEach(async () => {
  project = await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-function-"));
  // The project's dependencies, such as the server its plugin is written against.
  await fs.symlink(
    path.join(packageRoot, "node_modules"),
    path.join(project, "node_modules"),
  );
  functionsDir = path.join(project, "functions");
  await fs.mkdir(functionsDir);
});

afterEach(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

describe("the managed Cloud Function from a project's server definition", () => {
  it("bundles the definition on the function's own project, with the project's plugin", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, DEFINITION);

    await buildFunctionFromDefinition({ definition, packageRoot, functionsDir });

    // The function's code is one file; the entry that built it is gone.
    await expect(fs.readdir(functionsDir)).resolves.toEqual(["index.cjs"]);
    const code = await fs.readFile(
      path.join(functionsDir, "index.cjs"),
      "utf-8",
    );
    expect(code).toContain("sample notes plugin");
    // Init replaces it with the region it deploys to.
    expect(code).toContain("HotUpdater.REGION");
    // The function installs the Firebase SDKs; everything else is inside.
    expect(code).toMatch(/require\("firebase-admin\/app"\)/u);
    expect(code).toMatch(/require\("firebase-functions\/v2\/https"\)/u);
    expect(code).not.toMatch(/require\("@hot-updater\//u);

    // It loads as the function does, on the project Firebase configures,
    // and answers the health check.
    const previousConfig = process.env.FIREBASE_CONFIG;
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: "demo-hot-updater",
      storageBucket: "demo-hot-updater.appspot.com",
    });
    globalThis.HotUpdater = { REGION: "us-central1" };
    try {
      const { hot } = createRequire(import.meta.url)(
        path.join(functionsDir, "index.cjs"),
      ) as {
        hot: {
          updater: { v1: (request: unknown, response: unknown) => unknown };
        };
      };
      const sent: { status?: number; body?: string } = {};
      await hot.updater.v1(
        {
          hostname: "us-central1-demo-hot-updater.cloudfunctions.net",
          originalUrl: "/ping",
          method: "GET",
          headers: {},
        },
        {
          status: (status: number) => {
            sent.status = status;
          },
          setHeader: () => undefined,
          send: (body: string) => {
            sent.body = body;
          },
        },
      );
      expect(sent).toEqual({ status: 200, body: "pong" });
    } finally {
      if (previousConfig === undefined) delete process.env.FIREBASE_CONFIG;
      else process.env.FIREBASE_CONFIG = previousConfig;
    }
  });

  it("names the function when the definition cannot be bundled", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );

    await expect(
      buildFunctionFromDefinition({ definition, packageRoot, functionsDir }),
    ).rejects.toThrow(
      `Could not build the Firebase Cloud Function with ${path.join(functionsDir, "managed.ts")}`,
    );
    await expect(fs.readdir(functionsDir)).resolves.toEqual([]);
  });
});
