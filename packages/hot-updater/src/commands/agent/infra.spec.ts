import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INFRASTRUCTURE_UPDATES } from "../infrastructureUpdates";

const cliPath = path.resolve(import.meta.dirname, "../../../dist/index.mjs");
const templatesRoot = path.resolve(
  import.meta.dirname,
  "../../../dist/infra-templates",
);
const providers = ["cloudflare", "supabase", "aws", "firebase"] as const;
const builds = ["bare", "rock", "expo"] as const;
let cwd: string;

const run = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [cliPath, "agent", "infra", ...args, "--json"],
    {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOT_UPDATER_CLOUDFLARE_API_TOKEN: "test-private-input-never-print",
        NO_COLOR: "1",
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout).not.toContain("test-private-input-never-print");
  return { ...result, data: JSON.parse(result.stdout) };
};
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "hot-updater-agent-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("published agent infrastructure commands", () => {
  it("prints bootstrap instructions without prompting or changing the project", async () => {
    const result = run("setup");
    expect(result.status).toBe(0);
    expect(result.data).toMatchObject({
      status: "needs-input",
      operation: "setup",
      providers: expect.arrayContaining([...providers]),
    });
    expect(result.data.instructions).toContain(
      "--provider <provider> --build <build>",
    );
    expect(await readdir(cwd)).toEqual([]);
  });

  it.each(providers)(
    "packages a complete %s scaffold for every build",
    async (provider) => {
      for (const build of builds) {
        const result = run("setup", "--provider", provider, "--build", build);
        expect(result.status, result.stderr).toBe(0);
        expect(result.data.status).toBe("created");
        expect(path.isAbsolute(result.data.instructions)).toBe(true);
        const manifest = await json(result.data.manifest);
        expect(manifest).toMatchObject({
          provider,
          build,
          operation: "setup",
          schemaVersion: 1,
          infrastructureGeneration: 1,
        });
        expect(manifest.packages[`@hot-updater/${build}`]).toBeTruthy();
        for (const other of builds.filter((candidate) => candidate !== build)) {
          expect(manifest.packages[`@hot-updater/${other}`]).toBeUndefined();
        }
        for (const [file, hash] of Object.entries(manifest.files)) {
          const content = await readFile(path.join(result.data.output, file));
          expect(createHash("sha256").update(content).digest("hex")).toBe(hash);
        }
        const config = await readFile(
          path.join(result.data.output, "app/hot-updater.config.ts"),
          "utf8",
        );
        expect(config).toContain(`@hot-updater/${build}`);
        expect(config).toContain(`@hot-updater/${provider}`);
        expect(await json(result.data.deployment)).toMatchObject({
          provider,
          deployedServerVersion: null,
          verifiedSteps: [],
        });
        const notes = await readFile(result.data.upgradeNotes, "utf8");
        for (const entry of INFRASTRUCTURE_UPDATES) {
          expect(notes).toContain(`## ${entry.version}: ${entry.note}`);
          for (const step of entry.providers[provider])
            expect(notes).toContain(step);
        }
      }
    },
  );

  it("preserves agent edits and verified deployment state on a retry", async () => {
    const first = run(
      "setup",
      "--provider",
      "cloudflare",
      "--build",
      "expo",
    ).data;
    const config = path.join(first.output, "worker/wrangler.json");
    await writeFile(config, '{"name":"my-existing-worker"}\n');
    await writeFile(
      first.deployment,
      '{"resources":{"d1DatabaseId":"already-created"}}\n',
    );
    const retry = run("setup", "--provider", "cloudflare", "--build", "expo");
    expect(retry.status).toBe(0);
    expect(retry.data.status).toBe("existing");
    expect(await json(config)).toEqual({ name: "my-existing-worker" });
    expect(await json(first.deployment)).toEqual({
      resources: { d1DatabaseId: "already-created" },
    });
  });

  it("generates upgrade inputs separately from the original installation", async () => {
    const setup = run(
      "setup",
      "--provider",
      "supabase",
      "--build",
      "bare",
    ).data;
    const upgrade = run("upgrade", "--provider", "supabase", "--build", "bare");
    expect(upgrade.status).toBe(0);
    expect(upgrade.data.output).not.toBe(setup.output);
    expect(await json(setup.manifest)).toMatchObject({ operation: "setup" });
    expect(await json(upgrade.data.manifest)).toMatchObject({
      operation: "upgrade",
    });
    expect(upgrade.data.instructions).toMatch(/UPGRADE\.md$/);
  });

  it("rejects occupied, mismatched and incomplete outputs without overwriting them", async () => {
    await writeFile(path.join(cwd, "keep.txt"), "keep");
    const foreign = run(
      "setup",
      "--provider",
      "aws",
      "--build",
      "bare",
      "--output",
      cwd,
    );
    expect(foreign.status).toBe(1);
    expect(await readFile(path.join(cwd, "keep.txt"), "utf8")).toBe("keep");
    const first = run("setup", "--provider", "aws", "--build", "bare").data;
    expect(
      run(
        "upgrade",
        "--provider",
        "aws",
        "--build",
        "bare",
        "--output",
        first.output,
      ).status,
    ).toBe(1);
    await rm(path.join(first.output, "lambda/index.cjs"));
    expect(run("setup", "--provider", "aws", "--build", "bare").status).toBe(1);
    expect(await json(first.manifest)).toMatchObject({ operation: "setup" });
  });

  it("rejects a symlink destination and manifest path traversal", async () => {
    const first = run(
      "setup",
      "--provider",
      "firebase",
      "--build",
      "bare",
    ).data;
    const alias = path.join(cwd, "alias");
    await symlink(first.output, alias);
    expect(
      run(
        "setup",
        "--provider",
        "firebase",
        "--build",
        "bare",
        "--output",
        alias,
      ).status,
    ).toBe(1);
    const manifest = await json(first.manifest);
    manifest.files["../../outside"] = "fake";
    await writeFile(first.manifest, JSON.stringify(manifest));
    const result = run("setup", "--provider", "firebase", "--build", "bare");
    expect(result.status).toBe(1);
    expect(result.data.error).toContain("outside");
  });

  it("lets agents inspect an expo-updates app without executing its config", async () => {
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { "expo-updates": "1.0.0" } }),
    );
    await writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      'throw new Error("config must not execute");',
    );
    expect(
      run("setup", "--provider", "cloudflare", "--build", "expo").status,
    ).toBe(0);
    const doctor = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(doctor.status).toBe(1);
    expect(doctor.stdout + doctor.stderr).toContain("expo-updates");
  });
});

describe("deployment artifacts", () => {
  it.each(providers)(
    "loads the generated %s key config without a build plugin or storage credentials",
    async (provider) => {
      const scaffold = run(
        "setup",
        "--provider",
        provider,
        "--build",
        "bare",
      ).data;
      const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
      const providerRoot = path.join(repoRoot, "plugins", provider);
      for (const name of [
        `@hot-updater/${provider}`,
        "dotenv",
        ...(provider === "aws" ? ["@aws-sdk/credential-providers"] : []),
        ...(provider === "firebase" ? ["firebase-admin"] : []),
      ]) {
        const target = path.join(cwd, "node_modules", name);
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(
          name === `@hot-updater/${provider}`
            ? providerRoot
            : path.join(
                name === "dotenv"
                  ? path.join(repoRoot, "packages/hot-updater")
                  : providerRoot,
                "node_modules",
                name,
              ),
          target,
        );
      }
      const configUrl = pathToFileURL(
        path.join(scaffold.output, "app/api-key.config.ts"),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const { database } = await import(${JSON.stringify(configUrl.href)}); console.log(Boolean(database.models.apiKeys)); await database.dispose?.();`,
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 15_000,
          env: {
            PATH: process.env["PATH"],
            HOT_UPDATER_CLOUDFLARE_ACCOUNT_ID: "test-account",
            HOT_UPDATER_CLOUDFLARE_API_TOKEN: "test-token",
            HOT_UPDATER_CLOUDFLARE_D1_DATABASE_ID: "test-database",
            HOT_UPDATER_SUPABASE_URL: "https://test.supabase.co",
            HOT_UPDATER_SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
            HOT_UPDATER_S3_REGION: "us-east-1",
            HOT_UPDATER_DYNAMODB_TABLE_NAME: "test-table",
            HOT_UPDATER_CLOUDFRONT_DISTRIBUTION_ID: "test-distribution",
            HOT_UPDATER_FIREBASE_PROJECT_ID: "test-project",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("true");
    },
  );

  it("ships the Cloudflare bundled entry and required bindings", async () => {
    const root = path.join(templatesRoot, "cloudflare/worker");
    const config = await json(path.join(root, "wrangler.json"));
    expect(
      (await readFile(path.resolve(root, config.main))).length,
    ).toBeGreaterThan(0);
    expect(config.d1_databases[0].binding).toBe("DB");
    expect(config.r2_buckets[0].binding).toBe("BUCKET");
    expect(config.cache.enabled).toBe(true);
    expect(
      (await readdir(path.join(root, "migrations"))).some((file) =>
        file.endsWith(".sql"),
      ),
    ).toBe(true);
  });

  it("ships the Supabase function with resolvable vendored imports", async () => {
    const root = path.join(
      templatesRoot,
      "supabase/supabase/functions/hot-updater-v1",
    );
    const config = await json(path.join(root, "deno.json"));
    expect(config.imports["@hot-updater/server"]).toMatch(/^\.\//);
    expect(config.imports["@hot-updater/supabase/edge"]).toMatch(/^\.\//);
    for (const target of Object.values(config.imports) as string[]) {
      if (target.startsWith("."))
        expect(
          (await readFile(path.resolve(root, target))).length,
        ).toBeGreaterThan(0);
      else expect(target).toMatch(/^npm:[^ ]+@\d/);
    }
    const source = await readFile(path.join(root, "index.ts"), "utf8");
    expect(source).not.toContain("HotUpdater.BUCKET_NAME");
    expect(source).toContain("__HOT_UPDATER_BUCKET_NAME__");
  });

  it.each(["aws", "firebase"])(
    "ships %s runtime dependencies instead of relying on monorepo imports",
    async (provider) => {
      const root = path.join(
        templatesRoot,
        provider,
        provider === "aws" ? "lambda" : "firebase/functions",
      );
      const pkg = await json(path.join(root, "package.json"));
      const source = await readFile(path.join(root, pkg.main), "utf8");
      for (const [, specifier] of source.matchAll(
        /\brequire\(["']([^"']+)["']\)/g,
      )) {
        if (
          !specifier ||
          specifier.startsWith("node:") ||
          specifier.startsWith(".")
        )
          continue;
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!;
        expect(pkg.dependencies[name], specifier).toMatch(/^\d+\.\d+\.\d+/);
      }
      expect(source).not.toMatch(
        /HotUpdater\.(REGION|DYNAMODB_REGION|S3_BUCKET_NAME)/,
      );
      const check = spawnSync(
        process.execPath,
        ["--check", path.join(root, pkg.main)],
        { encoding: "utf8" },
      );
      expect(check.status, check.stderr).toBe(0);
    },
  );
});
