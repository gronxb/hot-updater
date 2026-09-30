import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

const SCRIPT = "provision-client-credential.mjs";
const SECRET = "client-credential.local";

let root: string;

/**
 * The script beside a fake `@hot-updater/server/db` whose clientAuth plugin
 * is named in hotUpdater.plugins.ts, as the scaffold's app/ directory holds it.
 */
const scaffold = async (options: {
  readonly plugins: string;
  readonly config?: string;
}) => {
  await cp(
    path.resolve(import.meta.dirname, "../../../agent", SCRIPT),
    path.join(root, SCRIPT),
  );
  await writeFile(
    path.join(root, "database.config.ts"),
    options.config ?? "export const database = {};\n",
  );
  await writeFile(
    path.join(root, "hotUpdater.plugins.ts"),
    `export const plugins = ${options.plugins};\n`,
  );
  const moduleRoot = path.join(root, "node_modules/@hot-updater/server");
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(
    path.join(moduleRoot, "package.json"),
    JSON.stringify({ type: "module", exports: { "./db": "./db.mjs" } }),
  );
  // The server's credential helpers, over a plugin list of names.
  await writeFile(
    path.join(moduleRoot, "db.mjs"),
    `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const credential = { label: "API key", header: "x-api-key", env: "HOT_UPDATER_API_KEY" };
export const clientAuthOf = (plugins) =>
  plugins.includes("apiKeys") ? { plugin: "apiKeys", varyHeaders: ["x-api-key"], credential } : undefined;
export const generateClientCredential = () => "generated-credential";
export const provisionClientCredential = async (_database, _plugins, { env }) => {
  appendFileSync("calls", "provision\\n");
  const value = env.HOT_UPDATER_API_KEY;
  if (readFileSync("${SECRET}", "utf8") !== value) throw new Error("Credential was not saved before registration");
  writeFileSync("registered", value);
  if (process.env.FAIL_AFTER_REGISTRATION) throw new Error("Registration response lost");
  return { ...credential, value };
};
`,
  );
};

const run = (options: { fail?: boolean; existing?: string } = {}) =>
  spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      HOT_UPDATER_API_KEY: options.existing ?? "",
      FAIL_AFTER_REGISTRATION: options.fail ? "1" : "",
    },
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hot-updater-agent-credential-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("saves the credential before registering it and reuses it after an unknown remote result", async () => {
  await scaffold({ plugins: '["insights", "apiKeys"]' });

  const first = run({ fail: true });
  expect(first.status).toBe(1);
  const saved = await readFile(path.join(root, SECRET), "utf8");
  expect(saved).toBe("generated-credential");
  expect((await stat(path.join(root, SECRET))).mode & 0o777).toBe(0o600);

  const second = run();
  expect(second.status, second.stderr).toBe(0);
  expect(await readFile(path.join(root, "registered"), "utf8")).toBe(saved);
  expect(second.stdout).toContain(
    "Client API key registered. It is saved in client-credential.local.",
  );
  expect(
    first.stdout + first.stderr + second.stdout + second.stderr,
  ).not.toContain(saved);

  const conflicting = run({ existing: "a-different-credential" });
  expect(conflicting.status).toBe(1);
  expect(conflicting.stderr).toContain("Saved client credentials differ");
  expect(await readFile(path.join(root, SECRET), "utf8")).toBe(saved);
});

it("reuses the credential the environment holds", async () => {
  await scaffold({ plugins: '["apiKeys"]' });

  const result = run({ existing: "existing-credential" });

  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(path.join(root, SECRET), "utf8")).toBe(
    "existing-credential",
  );
  expect(await readFile(path.join(root, "registered"), "utf8")).toBe(
    "existing-credential",
  );
});

it("runs the config's migration before registering the credential", async () => {
  await scaffold({
    plugins: '["apiKeys"]',
    config: `import { appendFileSync } from "node:fs";
export const database = {};
export const migrate = async () => appendFileSync("calls", "migrate\\n");
`,
  });

  const result = run();

  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(path.join(root, "calls"), "utf8")).toBe(
    "migrate\nprovision\n",
  );
});

it("only migrates when client routes are public", async () => {
  await scaffold({
    plugins: '["insights"]',
    config: `import { appendFileSync } from "node:fs";
export const database = {};
export const migrate = async () => appendFileSync("calls", "migrate\\n");
`,
  });

  const result = run();

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "Client routes are public: there is no client credential.",
  );
  expect(await readFile(path.join(root, "calls"), "utf8")).toBe("migrate\n");
  await expect(stat(path.join(root, SECRET))).rejects.toThrow();
});
