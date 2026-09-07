import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cliPath = path.resolve(import.meta.dirname, "../../../dist/index.mjs");
let cwd: string;
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const run = (...args: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env["PATH"], NO_COLOR: "1" },
  });
  expect(result.error).toBeUndefined();
  return result;
};

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-infra-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("public infrastructure scaffolding", () => {
  it.each(["cloudflare", "supabase", "aws", "firebase"])(
    "extracts %s server templates without an app and shares them with both agent commands",
    async (provider) => {
      const result = run("infra", "scaffold", "--provider", provider);
      expect(result.status, result.stderr).toBe(0);
      const scaffold = JSON.parse(result.stdout);
      const manifest = await json(scaffold.manifest);
      expect(manifest.operation).toBe("scaffold");
      expect(manifest.build).toBeUndefined();
      expect(manifest.packages).toBeUndefined();
      expect(scaffold.deployment).toBeUndefined();
      expect(scaffold.instructions).toBeUndefined();
      const files = await readdir(scaffold.output);
      for (const file of [
        "app",
        "COMMON.md",
        "ENVIRONMENT.md",
        "deployment.json",
        "env.example",
      ])
        expect(files).not.toContain(file);
      expect(await readFile(scaffold.upgradeGuide, "utf8")).toContain(
        "./1.0.0.md",
      );
      expect(scaffold.upgradeFiles[0]).toMatchObject({ version: "1.0.0" });
      expect(await readFile(scaffold.upgradeFiles[0].path, "utf8")).toContain(
        "# 1.0.0",
      );
      for (const operation of ["setup", "upgrade"]) {
        const agentResult = run(
          "agent",
          "infra",
          operation,
          "--provider",
          provider,
          "--build",
          "bare",
        );
        expect(agentResult.status, agentResult.stderr).toBe(0);
        const agent = JSON.parse(agentResult.stdout);
        expect(agent.output).not.toBe(scaffold.output);
        const agentManifest = await json(agent.manifest);
        for (const [file, hash] of Object.entries(manifest.files)) {
          expect(agentManifest.files[file], file).toBe(hash);
          expect(await readFile(path.join(agent.output, file))).toEqual(
            await readFile(path.join(scaffold.output, file)),
          );
        }
      }
    },
  );

  it("preserves manual edits and prevents an agent scaffold from replacing a public scaffold", async () => {
    const args = [
      "infra",
      "scaffold",
      "--provider",
      "cloudflare",
      "--output",
      "./server",
    ];
    const first = JSON.parse(run(...args).stdout);
    const configPath = path.join(first.output, "worker/wrangler.json");
    await writeFile(configPath, '{"name":"manually-configured"}\n');
    const retry = run(...args);
    expect(retry.status).toBe(0);
    expect(JSON.parse(retry.stdout).status).toBe("existing");
    expect(await json(configPath)).toEqual({ name: "manually-configured" });
    const agent = run(
      "agent",
      "infra",
      "setup",
      "--provider",
      "cloudflare",
      "--build",
      "bare",
      "--output",
      first.output,
    );
    expect(agent.status).toBe(1);
    expect(await json(configPath)).toEqual({ name: "manually-configured" });
  });

  it("requires a provider without creating files or reading app configuration", async () => {
    expect(run("infra", "scaffold").status).toBe(1);
    expect(await readdir(cwd)).toEqual([]);
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "expo-updates": "1.0.0" } }),
    );
    await writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      'throw new Error("must not evaluate app configuration");',
    );
    const result = run("infra", "scaffold", "--provider", "firebase");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe("created");
  });
});
