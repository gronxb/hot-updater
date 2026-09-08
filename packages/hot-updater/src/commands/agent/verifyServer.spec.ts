import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { ReleaseCatalog } from "@hot-updater/core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("../../../../react-native/src/catalogCacheNative", () => ({
  readNativeReleaseCatalogCache: async () => null,
  writeNativeReleaseCatalogCache: async () => false,
  removeNativeReleaseCatalogCache: async () => undefined,
}));

// Load the real parser without including React Native types in the CLI project.
const { fetchReleaseCatalogWithCache } = await vi.importActual<{
  fetchReleaseCatalogWithCache: (
    input: Record<string, unknown>,
  ) => Promise<ReleaseCatalog>;
}>(
  path.resolve(
    import.meta.dirname,
    "../../../../react-native/src/releaseCatalogCache.ts",
  ),
);

const require = createRequire(import.meta.url);
const apiKey = "private-client-key-never-print";
const serverVersion = "1.0.0-rc.2";
const channel = "preview/한글";
const channelKey = Buffer.from(channel).toString("base64url");
const catalogContentType =
  "application/vnd.hot-updater.release-catalog+json; version=1";
const releaseDescriptor = {
  releaseId: "01906c0c-5f14-7000-8000-000000000001",
  kind: "BUNDLE" as const,
  bundleId: "01906c0c-5f14-7000-8000-000000000002",
  rolloutCohortCount: 1000,
  targetCohorts: ["preview"],
  shouldForceUpdate: false,
  message: null,
};
const fingerprintCatalog: ReleaseCatalog = {
  schemaVersion: 1,
  catalogId: "test-project",
  catalogHash: `sha256:${"ab".repeat(32)}`,
  scopeKey: `v1:fingerprint:ios:${channelKey}:fingerprint-123`,
  generation: 3,
  fallbackPolicy: "BUILTIN_IF_ACTIVE_INELIGIBLE",
  releases: [releaseDescriptor],
  rollbackReleases: [
    {
      ...releaseDescriptor,
      releaseId: "01906c0c-5f14-7000-8000-000000000003",
      kind: "EMBEDDED",
      bundleId: null,
      rolloutCohortCount: 0,
    },
  ],
};

type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

const emptyCatalog: Reply = {
  status: 404,
  body: { error: "Not found" },
  headers: { "cache-control": "private, no-store" },
};

const createFixture = async (
  options: {
    version?: unknown;
    anonymous?: Reply;
    authenticated?: Reply;
    localKey?: string;
    environmentKey?: string;
    hangAuthenticated?: boolean;
  } = {},
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hot-updater-probe-"));
  const app = path.join(root, "scaffold/app");
  const requests: { path: string; key: string | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      key: request.headers["x-api-key"] as string | undefined,
    });
    const respond = (reply: Reply) => {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(JSON.stringify(reply.body));
    };
    if (request.url === "/functions/v1/hot-updater/version") {
      respond({
        status: 200,
        body: options.version ?? {
          version: serverVersion,
          infrastructureGeneration: 1,
        },
      });
      return;
    }
    if (!request.headers["x-api-key"]) {
      respond(
        options.anonymous ?? { status: 401, body: { error: "Unauthorized" } },
      );
      return;
    }
    if (options.hangAuthenticated) {
      response.writeHead(200, { "content-type": catalogContentType });
      response.write("{");
      return;
    }
    respond(options.authenticated ?? emptyCatalog);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(app, { recursive: true });
  await mkdir(path.join(root, "node_modules"));
  await symlink(
    path.dirname(require.resolve("dotenv/package.json")),
    path.join(root, "node_modules/dotenv"),
  );
  await cp(
    path.resolve(import.meta.dirname, "../../../agent/verify-server.mjs"),
    path.join(app, "verify-server.mjs"),
  );
  await writeFile(
    path.join(root, "scaffold/manifest.json"),
    JSON.stringify({ serverVersion, infrastructureGeneration: 1 }),
  );
  await writeFile(
    path.join(root, ".env.hotupdater"),
    `HOT_UPDATER_API_KEY=${options.environmentKey ?? apiKey}\n`,
  );
  if (options.localKey !== undefined) {
    await writeFile(path.join(app, "api-key.local"), options.localKey);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const baseUrl = `http://127.0.0.1:${address.port}/functions/v1/hot-updater/`;
  const run = (extraArgs: string[] = [], targetUrl = baseUrl) => {
    const environment = { ...process.env };
    delete environment["HOT_UPDATER_API_KEY"];
    return new Promise<{
      code: number | string;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        [
          path.join(app, "verify-server.mjs"),
          "--base-url",
          targetUrl,
          "--platform",
          "ios",
          "--channel",
          channel,
          ...(extraArgs.length ? extraArgs : ["--app-version", "1.0.0"]),
        ],
        { cwd: root, env: environment, timeout: 15_000 },
        (error, stdout, stderr) => {
          resolve({ code: error?.code ?? 0, stdout, stderr });
        },
      );
    });
  };
  const verifyWithNativeClient = () =>
    fetchReleaseCatalogWithCache({
      baseURL: baseUrl,
      url: `${baseUrl}release-catalogs/fingerprint/ios/${channelKey}/fingerprint-123`,
      expectedScope: {
        strategy: "FINGERPRINT",
        platform: "ios",
        channelKey,
        fingerprintHash: "fingerprint-123",
      },
      requestHeaders: { "x-api-key": apiKey },
    });
  return { run, requests, root, baseUrl, verifyWithNativeClient };
};

describe("agent server verification", () => {
  it("verifies an empty server using the private environment file and preserves the endpoint prefix", async () => {
    const { run, requests } = await createFixture();
    const result = await run();
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "verified",
      checks: {
        version: "matches-manifest",
        anonymousCatalog: 401,
        authenticatedCatalog: 404,
        catalog: "empty",
      },
    });
    const catalogPath =
      `/functions/v1/hot-updater/release-catalogs/app-version/ios/` +
      `${channelKey}/1.0.0`;
    expect(requests).toEqual([
      { path: "/functions/v1/hot-updater/version", key: undefined },
      { path: catalogPath, key: undefined },
      { path: catalogPath, key: apiKey },
    ]);
    expect(result.stdout + result.stderr).not.toContain(apiKey);
  });

  it("verifies a populated fingerprint catalog using the persisted local key", async () => {
    const { run, requests, verifyWithNativeClient } = await createFixture({
      environmentKey: "",
      localKey: apiKey,
      authenticated: {
        status: 200,
        headers: { "content-type": catalogContentType },
        body: fingerprintCatalog,
      },
    });
    const result = await run(["--fingerprint", "fingerprint-123"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).checks.catalog).toBe("available");
    expect(requests[2]).toEqual({
      path: `/functions/v1/hot-updater/release-catalogs/fingerprint/ios/${channelKey}/fingerprint-123`,
      key: apiKey,
    });
    expect(result.stdout + result.stderr).not.toContain(apiKey);
    await expect(verifyWithNativeClient()).resolves.toEqual(fingerprintCatalog);
  });

  it.each<[string, Partial<ReleaseCatalog>]>([
    ["malformed hash", { catalogHash: "sha256:catalog" }],
    ["zero generation", { generation: 0 }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
    [
      "invalid release ID",
      { releases: [{ ...releaseDescriptor, releaseId: "test-release" }] },
    ],
    [
      "bundle without an artifact ID",
      { releases: [{ ...releaseDescriptor, bundleId: null }] },
    ],
    [
      "embedded release with an artifact ID",
      { releases: [{ ...releaseDescriptor, kind: "EMBEDDED" }] },
    ],
    [
      "cohort rollout above the client range",
      { releases: [{ ...releaseDescriptor, rolloutCohortCount: 1001 }] },
    ],
    [
      "too many target cohorts on one release",
      {
        releases: [
          { ...releaseDescriptor, targetCohorts: Array(101).fill("preview") },
        ],
      },
    ],
    [
      "too many distinct target cohorts across current and rollback releases",
      {
        releases: Array.from({ length: 5 }, (_, index) => ({
          ...releaseDescriptor,
          targetCohorts: Array.from(
            { length: 100 },
            (_, cohort) => `cohort-${index * 100 + cohort}`,
          ),
        })),
        rollbackReleases: [
          {
            ...releaseDescriptor,
            targetCohorts: Array.from(
              { length: 13 },
              (_, cohort) => `rollback-${cohort}`,
            ),
          },
        ],
      },
    ],
  ])(
    "rejects %s just as the native catalog parser does",
    async (_name, invalid) => {
      const { run, verifyWithNativeClient } = await createFixture({
        authenticated: {
          status: 200,
          headers: { "content-type": catalogContentType },
          body: { ...fingerprintCatalog, ...invalid },
        },
      });
      const result = await run(["--fingerprint", "fingerprint-123"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).check).toBe("authenticated-catalog");
      await expect(verifyWithNativeClient()).rejects.toThrow(
        "Received an invalid Release catalog",
      );
    },
  );

  it.each([
    { version: "1.0.0-rc.1", infrastructureGeneration: 1 },
    { version: serverVersion, infrastructureGeneration: 0 },
    { version: serverVersion },
  ])(
    "rejects incompatible deployed infrastructure before sending a client key (%j)",
    async (version) => {
      const { run, requests } = await createFixture({ version });
      const result = await run();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).check).toBe("version");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.key).toBeUndefined();
    },
  );

  it("rejects a public catalog before attempting authenticated verification", async () => {
    const { run, requests } = await createFixture({
      anonymous: { status: 200, body: { unexpected: true } },
    });
    const result = await run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).check).toBe("anonymous-catalog");
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.key === undefined)).toBe(true);
  });

  it.each<Reply>([
    { status: 401, body: { error: "Unauthorized" } },
    { status: 404, body: { error: "Not found" } },
    {
      ...emptyCatalog,
      body: { error: "Wrong endpoint", token: apiKey },
    },
    {
      status: 200,
      body: { status: "healthy", token: apiKey },
      headers: { "content-type": catalogContentType },
    },
  ])(
    "rejects a failed key or misleading response (%j)",
    async (authenticated) => {
      const { run } = await createFixture({ authenticated });
      const result = await run();
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).check).toBe("authenticated-catalog");
      expect(result.stdout + result.stderr).not.toContain(apiKey);
    },
  );

  it("rejects conflicting locally stored keys before making requests", async () => {
    const { run, requests } = await createFixture({ localKey: "another-key" });
    const result = await run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).check).toBe("inputs");
    expect(requests).toHaveLength(0);
    expect(result.stdout + result.stderr).not.toContain(apiKey);
    expect(result.stdout + result.stderr).not.toContain("another-key");
  });

  it("never follows an authenticated redirect or leaks its destination", async () => {
    const { run, requests } = await createFixture({
      authenticated: {
        status: 302,
        headers: { location: `/unexpected-destination?token=${apiKey}` },
        body: { token: apiKey },
      },
    });
    const result = await run();
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(3);
    expect(result.stdout + result.stderr).not.toContain(apiKey);
    expect(result.stdout + result.stderr).not.toContain(
      "unexpected-destination",
    );
  });

  it("rejects URL credentials and ambiguous strategies without network access", async () => {
    const { run, requests, baseUrl } = await createFixture();
    const ambiguous = await run([
      "--app-version",
      "1.0.0",
      "--fingerprint",
      "fingerprint-123",
    ]);
    const credentials = await run(
      [],
      baseUrl.replace("http://", `http://user:${apiKey}@`),
    );
    const traversal = await run(["--fingerprint", ".."]);
    const emptyAlternative = await run([
      "--app-version",
      "1.0.0",
      "--fingerprint",
      "",
    ]);
    expect(ambiguous.code).toBe(1);
    expect(credentials.code).toBe(1);
    expect(traversal.code).toBe(1);
    expect(emptyAlternative.code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(credentials.stdout + credentials.stderr).not.toContain(apiKey);
  });

  it("bounds the wait for an authenticated response body", async () => {
    const { run } = await createFixture({ hangAuthenticated: true });
    const result = await run();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).check).toBe("authenticated-catalog");
    expect(result.stdout + result.stderr).not.toContain(apiKey);
  });
});
