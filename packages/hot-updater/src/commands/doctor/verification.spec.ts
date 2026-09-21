import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scaffoldInfra } from "../infra/scaffold";
import type { InitProvider } from "../initProviders";
import { checkScaffold } from "./scaffold";
import { verifyInfrastructure } from "./verification";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "doctor-verification-"));
  vi.stubEnv("HOT_UPDATER_API_KEY", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});

const readJson = async (file: string) =>
  JSON.parse(await readFile(file, "utf8"));
const saveJson = (file: string, value: unknown) =>
  writeFile(file, JSON.stringify(value));
const prepare = async (
  provider: InitProvider = "cloudflare",
  operation: "setup" | "scaffold" = "setup",
) => {
  const scaffold = await scaffoldInfra(operation, {
    provider,
    ...(operation === "setup" ? { build: "bare" as const } : {}),
    output: path.join(cwd, "infra"),
  });
  const manifest = await readJson(scaffold.manifest);
  for (const file of Object.keys(manifest.files)) {
    if (
      !/^(worker|supabase|lambda|cloudfront|dynamodb|iam|firebase)\//.test(
        file,
      ) ||
      /\.(md|map)$/.test(file)
    )
      continue;
    const absolute = path.join(scaffold.output, file);
    const source = await readFile(absolute, "utf8");
    await writeFile(
      absolute,
      source.replace(
        /__HOT_UPDATER_[A-Z0-9_]+__|%%BUCKET_NAME%%/g,
        "selected-resource",
      ),
    );
  }
  return scaffold;
};
const successful = (
  checks: Awaited<ReturnType<typeof checkScaffold>>["checks"],
) => checks.length > 0 && checks.every((check) => check.status === "pass");

describe("doctor scaffold contract", () => {
  it.each<InitProvider>(["cloudflare", "supabase", "aws", "firebase"])(
    "accepts configured %s templates and preserves harmless customizations",
    async (provider) => {
      const scaffold = await prepare(provider);
      const before = await readFile(scaffold.manifest, "utf8");
      const result = await checkScaffold(scaffold.output);
      expect(successful(result.checks), JSON.stringify(result.checks)).toBe(
        true,
      );
      // Filled values change original hashes. The manifest is not rewritten to pass.
      expect(await readFile(scaffold.manifest, "utf8")).toBe(before);
    },
  );

  it("does not certify freshly extracted unresolved deployment inputs", async () => {
    const scaffold = await scaffoldInfra("setup", {
      provider: "cloudflare",
      build: "bare",
      output: path.join(cwd, "infra"),
    });
    expect((await checkScaffold(scaffold.output)).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INFRA_UNRESOLVED_PLACEHOLDER",
          status: "fail",
          paths: ["worker/wrangler.json"],
        }),
      ]),
    );
  });

  it("finds a missing runtime even when an agent deletes its manifest entry", async () => {
    const scaffold = await prepare();
    const manifest = await readJson(scaffold.manifest);
    delete manifest.files["worker/dist/index.js"];
    await saveJson(scaffold.manifest, manifest);
    await rm(path.join(scaffold.output, "worker/dist/index.js"));
    const result = await checkScaffold(scaffold.output);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INFRA_FILE_MISSING_OR_UNSAFE",
          status: "fail",
          paths: ["worker/dist/index.js"],
        }),
      ]),
    );
  });

  it("rejects an empty runtime even if its file still exists", async () => {
    const scaffold = await prepare();
    await writeFile(path.join(scaffold.output, "worker/dist/index.js"), "");
    expect((await checkScaffold(scaffold.output)).checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_EMPTY_DEPLOYMENT_FILE",
        status: "fail",
        paths: ["worker/dist/index.js"],
      }),
    );
  });

  it.each(["missing DB", "wrong bucket", "invalid JSON"])(
    "rejects %s without printing configuration values",
    async (failure) => {
      const scaffold = await prepare();
      const file = path.join(scaffold.output, "worker/wrangler.json");
      const config = await readJson(file);
      if (failure === "missing DB") config.d1_databases = [];
      else if (failure === "wrong bucket")
        config.vars.BUCKET_NAME = "sensitive-test-value";
      if (failure === "invalid JSON")
        await writeFile(file, '{"secret":"sensitive-test-value"');
      else await saveJson(file, config);
      const result = await checkScaffold(scaffold.output);
      expect(successful(result.checks)).toBe(false);
      expect(JSON.stringify(result)).not.toContain("sensitive-test-value");
    },
  );

  it("accepts additional Worker settings and reordered named bindings", async () => {
    const scaffold = await prepare();
    const file = path.join(scaffold.output, "worker/wrangler.json");
    const config = await readJson(file);
    config.name = "custom-worker";
    config.vars.CUSTOM_SETTING = "preserved";
    config.d1_databases.unshift({ binding: "OTHER_DB", database_id: "other" });
    await saveJson(file, config);
    expect(successful((await checkScaffold(scaffold.output)).checks)).toBe(
      true,
    );
  });

  it("rejects paths and symlinks outside the scaffold", async () => {
    const scaffold = await prepare();
    const secret = path.join(cwd, "outside");
    await writeFile(secret, "must-not-be-disclosed");
    const manifest = await readJson(scaffold.manifest);
    manifest.files["../outside"] = "fake";
    await saveJson(scaffold.manifest, manifest);
    const file = path.join(scaffold.output, "worker/wrangler.json");
    await rm(file);
    await symlink(secret, file);
    const result = await checkScaffold(scaffold.output);
    expect(
      result.checks.filter(
        (check) => check.code === "INFRA_FILE_MISSING_OR_UNSAFE",
      ),
    ).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("must-not-be-disclosed");
  });

  it("blocks a manifest target version that differs from the installed templates", async () => {
    const scaffold = await prepare();
    const manifest = await readJson(scaffold.manifest);
    manifest.serverVersion = "0.0.0";
    await saveJson(scaffold.manifest, manifest);
    expect((await checkScaffold(scaffold.output)).checks).toEqual([
      expect.objectContaining({
        code: "INFRA_TEMPLATE_VERSION_MISMATCH",
        status: "blocked",
      }),
    ]);
  });

  it("checks public server scaffolds without an app or deployment record", async () => {
    const scaffold = await prepare("cloudflare", "scaffold");
    expect(successful((await checkScaffold(scaffold.output)).checks)).toBe(
      true,
    );
  });

  it("rejects changed build selection without the matching package targets", async () => {
    const scaffold = await prepare();
    const manifest = await readJson(scaffold.manifest);
    manifest.build = "expo";
    await saveJson(scaffold.manifest, manifest);
    expect((await checkScaffold(scaffold.output)).checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_PACKAGE_TARGET_MISMATCH",
        status: "fail",
      }),
    );
  });

  it("parses Supabase TOML instead of accepting example settings inside a string", async () => {
    const scaffold = await prepare("supabase");
    await writeFile(
      path.join(scaffold.output, "supabase/config.toml"),
      'project_id = "selected-project"\nexample = """\n[functions.hot-updater-v1]\nverify_jwt = false\n"""\n',
    );
    expect((await checkScaffold(scaffold.output)).checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_SUPABASE_FUNCTION",
        status: "fail",
      }),
    );
  });

  it("rejects CloudFront cache configuration that drops API-key isolation", async () => {
    const scaffold = await prepare("aws");
    const file = path.join(
      scaffold.output,
      "cloudfront/catalog-cache-policy.json",
    );
    const policy = await readJson(file);
    policy.CachePolicyConfig.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.Headers.Items =
      [];
    await saveJson(file, policy);
    expect((await checkScaffold(scaffold.output)).checks).toContainEqual(
      expect.objectContaining({ code: "INFRA_AWS_CACHE_AUTH", status: "fail" }),
    );
  });

  it("rejects a Firebase config that no longer deploys the packaged functions", async () => {
    const scaffold = await prepare("firebase");
    await saveJson(path.join(scaffold.output, "firebase/firebase.json"), {
      functions: { source: "other-functions" },
    });
    expect((await checkScaffold(scaffold.output)).checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_FIREBASE_FUNCTION",
        status: "fail",
      }),
    );
  });
});

describe("doctor infrastructure completion", () => {
  const setup = async () => {
    const scaffold = await prepare();
    await writeFile(
      path.join(scaffold.output, "app/api-key.local"),
      "private-client-key",
    );
    const manifest = await readJson(scaffold.manifest);
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (String(url).endsWith("/version"))
        return Response.json({
          version: manifest.serverVersion,
          infrastructureGeneration: 1,
        });
      if (!new Headers(init?.headers).has("x-api-key"))
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: { "cache-control": "private, no-store" } },
      );
    });
    return {
      scaffold,
      fetch,
      options: {
        cwd,
        scope: "infrastructure" as const,
        infraDir: scaffold.output,
        serverBaseUrl: "https://updates.example.test/functions/v1/hot-updater",
        platform: "ios",
        channel: "production",
        appVersion: "1.0.0",
        fetch,
      },
    };
  };

  it("requires all live checks, accepts the protocol's empty catalog and exposes untested boundaries", async () => {
    const { fetch, options } = await setup();
    const result = await verifyInfrastructure(options);
    expect(successful(result.checks), JSON.stringify(result)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      String(fetch.mock.calls[2]?.[0]),
    );
    expect(result.notChecked).toContain("native-ota");
    expect(JSON.stringify(result)).not.toContain("private-client-key");
  });

  it.each(["URL", "channel", "key"])(
    "blocks missing %s instead of succeeding with a skipped server check",
    async (missing) => {
      const { scaffold, fetch, options } = await setup();
      if (missing === "URL") options.serverBaseUrl = "";
      if (missing === "channel") options.channel = "";
      if (missing === "key")
        await rm(path.join(scaffold.output, "app/api-key.local"));
      const result = await verifyInfrastructure(options);
      expect(successful(result.checks)).toBe(false);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "INFRA_SERVER_INPUTS",
          status: "blocked",
        }),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("cannot replace live verification with agent-written verifiedSteps", async () => {
    const { scaffold, fetch, options } = await setup();
    const record = await readJson(scaffold.deployment!);
    record.verifiedSteps = [
      { id: "common.verify", observation: "all checks passed" },
    ];
    await saveJson(scaffold.deployment!, record);
    fetch.mockImplementation(async () =>
      Response.json({ version: "wrong", infrastructureGeneration: 1 }),
    );
    const result = await verifyInfrastructure(options);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ code: "INFRA_SERVER_VERSION", status: "fail" }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_AUTHENTICATED_CATALOG",
        status: "blocked",
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "different endpoint"])(
    "blocks an unresolved %s before sending a key",
    async (failure) => {
      const { scaffold, fetch, options } = await setup();
      const record = await readJson(scaffold.deployment!);
      if (failure === "pending")
        record.pendingStep = { id: "cf.worker", target: "selected-resource" };
      else record.baseUrl = "https://other.example.test";
      await saveJson(scaffold.deployment!, record);
      const result = await verifyInfrastructure(options);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          code: "INFRA_DEPLOYMENT_UNRESOLVED",
          status: "blocked",
        }),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects an arbitrary 404 rather than treating a missing route as an empty catalog", async () => {
    const { fetch, options } = await setup();
    const normalFetch = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) =>
      new Headers(init?.headers).has("x-api-key")
        ? Response.json({ error: "Not found" }, { status: 404 })
        : normalFetch(url, init),
    );
    const result = await verifyInfrastructure(options);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "INFRA_AUTHENTICATED_CATALOG",
        status: "fail",
      }),
    );
  });
});

describe("published doctor verification CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dirname, "../../../dist/index.mjs"),
        "doctor",
        ...args,
        "--json",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        env: { PATH: process.env["PATH"], NO_COLOR: "1" },
      },
    );

  it("returns machine-readable nonzero status for incomplete targets", () => {
    for (const args of [
      ["--scope", "scaffold"],
      ["--infra-dir", "./infra"],
    ]) {
      const result = run(...args);
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(result.stdout).success).toBe(false);
    }
  });

  it("checks actual artifacts without evaluating app config and reports failure after a binding is removed", async () => {
    const scaffold = await prepare();
    await mkdir(path.join(cwd, "app"));
    await writeFile(
      path.join(cwd, "hot-updater.config.ts"),
      'throw new Error("must not execute app config for scaffold checks");',
    );
    const args = ["--scope", "scaffold", "--infra-dir", scaffold.output];
    const passed = run(...args);
    expect(passed.status, passed.stdout + passed.stderr).toBe(0);
    expect(JSON.parse(passed.stdout).details.verification.scope).toBe(
      "scaffold",
    );
    const file = path.join(scaffold.output, "worker/wrangler.json");
    const config = await readJson(file);
    config.r2_buckets = [];
    await saveJson(file, config);
    const failed = run(...args);
    expect(failed.status).toBe(1);
    expect(
      JSON.parse(failed.stdout).details.verification.checks,
    ).toContainEqual(
      expect.objectContaining({
        code: "INFRA_CLOUDFLARE_BINDINGS",
        status: "fail",
      }),
    );
  });
});
