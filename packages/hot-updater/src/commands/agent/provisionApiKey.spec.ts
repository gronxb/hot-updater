import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

it("persists the client key before registration and reuses it after an unknown remote result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hot-updater-agent-key-"));
  try {
    await cp(
      path.resolve(import.meta.dirname, "../../../agent/provision-api-key.mjs"),
      path.join(root, "provision-api-key.mjs"),
    );
    await writeFile(
      path.join(root, "api-key.config.ts"),
      "export const database = { models: { apiKeys: {} } };\n",
    );
    const moduleRoot = path.join(root, "node_modules/@hot-updater/server");
    await mkdir(moduleRoot, { recursive: true });
    await writeFile(
      path.join(moduleRoot, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.mjs" }),
    );
    await writeFile(
      path.join(moduleRoot, "index.mjs"),
      `
import { readFile, writeFile } from "node:fs/promises";
export async function provisionApiKey({ existingApiKey }) {
  const persisted = await readFile("api-key.local", "utf8");
  if (persisted !== existingApiKey) throw new Error("Key was not persisted before registration");
  await writeFile("registered-key", existingApiKey);
  if (process.env.FAIL_AFTER_REGISTRATION) throw new Error("Registration response lost");
  return { record: { id: "key-record" } };
}
`,
    );
    const run = (fail: boolean, existingKey = "") =>
      spawnSync(process.execPath, ["provision-api-key.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOT_UPDATER_API_KEY: existingKey,
          FAIL_AFTER_REGISTRATION: fail ? "1" : "",
        },
      });
    const first = run(true);
    expect(first.status).toBe(1);
    const persisted = await readFile(path.join(root, "api-key.local"), "utf8");
    expect(persisted).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const second = run(false);
    expect(second.status, second.stderr).toBe(0);
    expect(await readFile(path.join(root, "registered-key"), "utf8")).toBe(
      persisted,
    );
    expect(
      first.stdout + first.stderr + second.stdout + second.stderr,
    ).not.toContain(persisted);
    const conflicting = run(false, "a-different-existing-key");
    expect(conflicting.status).toBe(1);
    expect(await readFile(path.join(root, "api-key.local"), "utf8")).toBe(
      persisted,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
