import fs from "fs/promises";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { InitError } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFunctionFromDefinition } from "./managedFunction";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

/** A project's server definition, as init writes it, with a plugin of its own. */
const DEFINITION = `import {
  firebaseDatabase,
  firebaseStorage,
  plugins,
} from "@hot-updater/firebase";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin, defineTable } from "@hot-updater/plugin-core";
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

/** A definition whose plugin answers with bytes and two cookies. */
const BINARY_DEFINITION = `import { firebaseDatabase, firebaseStorage } from "@hot-updater/firebase";
import { createHotUpdater } from "@hot-updater/server";
import { definePlugin } from "@hot-updater/plugin-core";

const bytes = definePlugin({
  id: "bytes",
  schemaVersion: "1",
  schema: {},
  init: () => ({
    api: {},
    endpoints: [
      {
        method: "GET",
        path: "/bytes",
        access: "client",
        handler: async () => {
          const headers = new Headers({
            "content-type": "application/octet-stream",
          });
          headers.append("set-cookie", "a=1; Path=/");
          headers.append("set-cookie", "b=2; Path=/");
          return new Response(new Uint8Array([0, 255, 128, 10]), { headers });
        },
      },
    ],
  }),
});

export const hotUpdater = createHotUpdater({
  database: firebaseDatabase({}),
  storage: [firebaseStorage({ storageBucket: "the CLI's" })],
  plugins: [bytes],
  clientAccess: "public",
});
`;

type FunctionHandler = (request: unknown, response: unknown) => unknown;

/** The function in `dir`, loaded as Cloud Functions loads it. */
const loadFunction = (dir: string): FunctionHandler => {
  globalThis.HotUpdater = { REGION: "us-central1" };
  const { hot } = createRequire(import.meta.url)(
    path.join(dir, "index.cjs"),
  ) as { hot: { updater: { v1: FunctionHandler } } };
  return hot.updater.v1;
};

/** What the function sends for a GET of `urlPath`. */
const get = async (handler: FunctionHandler, urlPath: string) => {
  const sent: {
    status?: number;
    headers: Record<string, unknown>;
    body?: Buffer;
  } = { headers: {} };
  await handler(
    {
      hostname: "us-central1-demo-hot-updater.cloudfunctions.net",
      originalUrl: urlPath,
      method: "GET",
      headers: {},
    },
    {
      status: (status: number) => {
        sent.status = status;
      },
      setHeader: (key: string, value: unknown) => {
        sent.headers[key] = value;
      },
      send: (body: Buffer) => {
        sent.body = body;
      },
    },
  );
  return sent;
};

let project: string;
let functionsDir: string;
let previousConfig: string | undefined;

beforeEach(async () => {
  // The project Firebase configures for the function.
  previousConfig = process.env["FIREBASE_CONFIG"];
  process.env["FIREBASE_CONFIG"] = JSON.stringify({
    projectId: "demo-hot-updater",
    storageBucket: "demo-hot-updater.appspot.com",
  });
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
  if (previousConfig === undefined) delete process.env["FIREBASE_CONFIG"];
  else process.env["FIREBASE_CONFIG"] = previousConfig;
  await fs.rm(project, { recursive: true, force: true });
});

describe("the managed Cloud Function from a project's server definition", () => {
  it("bundles the definition on the function's own project, with the project's plugin", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, DEFINITION);

    await buildFunctionFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      functionsDir,
    });

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
    // None of the machine's paths are deployed: not the project's, the
    // repository's its packages come from, or the home directory, not even
    // in a module's name, which esbuild writes from the project.
    for (const local of [
      project,
      await fs.realpath(project),
      repositoryRoot,
      await fs.realpath(repositoryRoot),
      os.homedir(),
    ]) {
      expect(code).not.toContain(local);
    }

    // It loads as the function does and answers the health check.
    const response = await get(loadFunction(functionsDir), "/ping");
    expect(response.status).toBe(200);
    expect(response.body?.toString()).toBe("pong");
  });

  it("sends a plugin's response as its bytes, with each of its cookies", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(definition, BINARY_DEFINITION);
    await buildFunctionFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      functionsDir,
    });

    const response = await get(loadFunction(functionsDir), "/bytes");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from([0, 255, 128, 10]));
    expect(response.headers["set-cookie"]).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("names the function when the definition cannot be bundled", async () => {
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { notes } from "@acme/missing-plugin";\nexport const hotUpdater = notes;\n`,
    );

    const failure = buildFunctionFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      functionsDir,
    });
    await expect(failure).rejects.toBeInstanceOf(InitError);
    await expect(failure).rejects.toThrow(
      /^Could not bundle hotUpdater\.ts into the Firebase Cloud Function: .*Could not resolve "@acme\/missing-plugin"/su,
    );
    await expect(fs.readdir(functionsDir)).resolves.toEqual([]);
  });

  it("offers the definition every export of @hot-updater/firebase", async () => {
    const names = Object.keys(await import("@hot-updater/firebase")).sort();
    const definition = path.join(project, "hotUpdater.ts");
    await fs.writeFile(
      definition,
      `import { ${names.join(", ")} } from "@hot-updater/firebase";
import { createHotUpdater } from "@hot-updater/server";

export const imported = [${names.join(", ")}];
export default createHotUpdater({
  database: firebaseDatabase({}),
  storage: [firebaseStorage({ storageBucket: "the CLI's" })],
  plugins,
});
`,
    );

    await buildFunctionFromDefinition({
      definition,
      packageRoot,
      projectRoot: project,
      functionsDir,
    });

    expect(names).toEqual(
      expect.arrayContaining([
        "firebaseDatabase",
        "firebaseStorage",
        "plugins",
      ]),
    );
  });
});
