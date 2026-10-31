import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  p: { log: { info: vi.fn(), warn: vi.fn() } },
}));
vi.mock("./utils/readIpaInfo", () => ({
  readIpaInfo: vi.fn(async () => ({
    bundleId: "com.example.app",
    shortVersion: "1.6.3",
    bundleVersion: "69",
  })),
  readIpaInternalTestingOnly: vi.fn(async () => true),
}));

import { p } from "@hot-updater/cli-tools";

import {
  applyTestFlightGroup,
  assertBuildIsInternalOnly,
  assertIpaIsInternalOnly,
  distributeTestFlightBuild,
  findInternalBetaGroup,
  prepareSandboxArchive,
  readAppStoreTrain,
  readTestFlightBuildStatus,
  sandboxVersionDecision,
} from "./sandboxTestFlight";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readIpaInternalTestingOnly } from "./utils/readIpaInfo";

const API = "https://api.appstoreconnect.apple.com";

let directory: string;
let apiKey: { keyPath: string; keyId: string; issuerId: string };

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-testflight-"));
  const keyPath = path.join(directory, "AuthKey.p8");
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  await fs.writeFile(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  apiKey = { keyPath, keyId: "ABC", issuerId: "issuer" };
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/** App Store Connect answering by path; a list repeats its last answer. */
const asc = (routes: Record<string, unknown>) => {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const pathname = url.slice(API.length).split("?")[0]!;
    const route = routes[pathname];
    const reply = Array.isArray(route)
      ? route.length > 1
        ? route.shift()
        : route[0]
      : route;
    return reply === undefined
      ? new Response(JSON.stringify({ errors: [] }), { status: 404 })
      : new Response(JSON.stringify(reply), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
};

const app = {
  "/v1/apps": {
    data: [{ id: "6764", attributes: { bundleId: "com.example.app" } }],
  },
};

const version = (versionString: string, appVersionState: string) => ({
  attributes: { versionString, appVersionState },
});

describe("sandboxVersionDecision", () => {
  const train = (highestClosedVersion: string | null) => ({
    highestClosedVersion,
    highestBuildNumber: null,
  });

  it.each([
    ["no version was approved", "1.0.0", null],
    ["its version is past the approved one", "1.7.0", "1.6.2"],
    ["a two-part version is past it", "1.7", "1.6.2"],
  ])("keeps the version when %s", (_, current, closed) => {
    for (const updateStrategy of ["fingerprint", "appVersion"] as const) {
      expect(
        sandboxVersionDecision({
          version: current,
          train: train(closed),
          updateStrategy,
        }),
      ).toEqual({ kind: "keep" });
    }
  });

  it.each([
    ["the approved version itself", "1.6.2", "1.6.2", "1.6.3"],
    ["a version below it", "1.5.0", "1.6.2", "1.6.3"],
    ["a two-part approved version", "1.2", "1.2", "1.2.1"],
  ])(
    "raises %s past the approved one under the fingerprint strategy",
    (_, current, closed, raised) => {
      expect(
        sandboxVersionDecision({
          version: current,
          train: train(closed),
          updateStrategy: "fingerprint",
        }),
      ).toEqual({ kind: "raise", version: raised });
    },
  );

  it("refuses under the appVersion strategy only when a raise would be needed, in one line and a next step", () => {
    expect(
      sandboxVersionDecision({
        version: "1.6.2",
        train: train("1.6.2"),
        updateStrategy: "appVersion",
      }),
    ).toEqual({
      kind: "refuse",
      message:
        "App Store Connect closed version 1.6.2, so TestFlight refuses 1.6.2.\nRaise the app version.",
    });
  });
});

describe("readAppStoreTrain", () => {
  it("takes the highest approved version and build number, and ignores versions still open", async () => {
    const { fetch, requests } = asc({
      ...app,
      "/v1/apps/6764/appStoreVersions": {
        data: [
          version("1.8.0", "PREPARE_FOR_SUBMISSION"),
          version("1.7.0", "WAITING_FOR_REVIEW"),
          version("1.6.2", "READY_FOR_DISTRIBUTION"),
          version("1.6.1", "READY_FOR_DISTRIBUTION"),
          version("1.10.0", "REJECTED"),
        ],
      },
      "/v1/builds": {
        data: [
          { attributes: { version: "9" } },
          { attributes: { version: "68" } },
          { attributes: { version: "1.2.3" } },
        ],
      },
    });

    expect(
      await readAppStoreTrain({ bundleId: "com.example.app", apiKey, fetch }),
    ).toEqual({ highestClosedVersion: "1.6.2", highestBuildNumber: 68 });
    expect(requests.some((url) => url.includes("appStoreVersions"))).toBe(true);
  });

  it("counts a state Apple adds later as closed, and an old appStoreState too", async () => {
    const { fetch } = asc({
      ...app,
      "/v1/apps/6764/appStoreVersions": {
        data: [
          version("2.0.0", "SOME_NEW_STATE"),
          {
            attributes: { versionString: "2.1.0", appStoreState: "IN_REVIEW" },
          },
        ],
      },
      "/v1/builds": { data: [] },
    });

    expect(
      await readAppStoreTrain({ bundleId: "com.example.app", apiKey, fetch }),
    ).toEqual({ highestClosedVersion: "2.0.0", highestBuildNumber: null });
  });
});

describe("prepareSandboxArchive", () => {
  const scheme = (
    overrides: Partial<EnrichedNativeBuildIosScheme> = {},
  ): EnrichedNativeBuildIosScheme => ({
    bundleIdentifier: "com.example.app",
    scheme: "App",
    platform: "ios",
    installPods: false,
    configuration: "Release",
    destination: [],
    simulator: false,
    sandbox: true,
    hotUpdaterSchemeName: "release",
    ...overrides,
  });
  const closed162 = {
    ...app,
    "/v1/apps/6764/appStoreVersions": {
      data: [version("1.6.2", "READY_FOR_DISTRIBUTION")],
    },
    "/v1/builds": { data: [{ attributes: { version: "68" } }] },
  };

  it("reads the train under appVersion, and leaves the refusal to the archive", async () => {
    expect(
      await prepareSandboxArchive({
        schemeConfig: scheme(),
        apiKey,
        updateStrategy: "appVersion",
        fetch: asc(closed162).fetch,
      }),
    ).toEqual({
      updateStrategy: "appVersion",
      train: { highestClosedVersion: "1.6.2", highestBuildNumber: 68 },
    });
  });

  it("warns, and reads nothing, without an API key", async () => {
    const { fetch, requests } = asc(closed162);
    expect(
      await prepareSandboxArchive({
        schemeConfig: scheme(),
        updateStrategy: "fingerprint",
        fetch,
      }),
    ).toEqual({ updateStrategy: "fingerprint" });
    expect(requests).toEqual([]);
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("can't check for a closed version"),
    );
  });

  it("reads nothing for an export that never reaches App Store Connect", async () => {
    const plist = path.join(directory, "AdHoc.plist");
    await fs.writeFile(
      plist,
      "<plist><dict><key>method</key><string>ad-hoc</string></dict></plist>",
    );
    const { fetch, requests } = asc(closed162);
    expect(
      await prepareSandboxArchive({
        schemeConfig: scheme({ exportOptionsPlist: plist }),
        apiKey,
        updateStrategy: "fingerprint",
        fetch,
      }),
    ).toEqual({ updateStrategy: "fingerprint" });
    expect(requests).toEqual([]);
  });
});

describe("the review block", () => {
  it("refuses an .ipa Xcode didn't mark for internal testing only", async () => {
    vi.mocked(readIpaInternalTestingOnly).mockResolvedValueOnce(false);
    await expect(assertIpaIsInternalOnly("/out/App.ipa")).rejects.toThrow(
      "App.ipa isn't marked for internal testing only (TFInternalTestingOnly), so it wasn't uploaded.\nExport it with testFlightInternalTestingOnly.",
    );
    await expect(assertIpaIsInternalOnly("/out/App.ipa")).resolves.toBe(
      undefined,
    );
  });

  const audience = (buildAudienceType: string | null) => ({
    data: [{ attributes: { buildAudienceType } }],
  });

  it("passes once App Store Connect says INTERNAL_ONLY, waiting while it says nothing", async () => {
    const { fetch, requests } = asc({
      ...app,
      "/v1/builds": [{ data: [] }, audience(null), audience("INTERNAL_ONLY")],
    });
    await assertBuildIsInternalOnly({
      ipaPath: "/out/App.ipa",
      apiKey,
      fetch,
      pollIntervalMs: 0,
    });
    expect(requests.filter((url) => url.includes("/v1/builds"))).toHaveLength(
      3,
    );
  });

  it("fails when App Store Connect holds it for anyone else", async () => {
    const { fetch } = asc({
      ...app,
      "/v1/builds": audience("APP_STORE_ELIGIBLE"),
    });
    await expect(
      assertBuildIsInternalOnly({ ipaPath: "/out/App.ipa", apiKey, fetch }),
    ).rejects.toThrow(
      "App Store Connect holds sandbox build 1.6.3 (69) for APP_STORE_ELIGIBLE, not INTERNAL_ONLY.",
    );
  });

  it("fails when it can't tell in time", async () => {
    const { fetch } = asc({ ...app, "/v1/builds": { data: [] } });
    await expect(
      assertBuildIsInternalOnly({
        ipaPath: "/out/App.ipa",
        apiKey,
        fetch,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("didn't say who sandbox build 1.6.3 (69) is for");
  });
});

/**
 * App Store Connect, recording every request with its body: the answer of
 * `<METHOD> <path>`, a list answering in turn and then repeating its last.
 */
const recordingAsc = (
  routes: Record<string, unknown | unknown[]>,
  statuses: Record<string, number> = {},
) => {
  const requests: {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
  }[] = [];
  const fetch = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const key = `${method} ${url.pathname}`;
      const route = routes[key];
      const reply = Array.isArray(route)
        ? route.length > 1
          ? route.shift()
          : route[0]
        : route;
      if (statuses[key]) {
        const status = statuses[key]!;
        delete statuses[key];
        return new Response(JSON.stringify({ errors: [] }), { status });
      }
      if (reply === undefined) {
        return new Response(JSON.stringify({ errors: [] }), { status: 404 });
      }
      return reply === null
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(reply), { status: 200 });
    },
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests };
};

const APPS = {
  data: [{ id: "6764", attributes: { bundleId: "com.example.app" } }],
};

const listedBuild = (
  attributes: Record<string, unknown>,
  internalBuildState?: string,
) => ({
  data: [{ id: "build-1", attributes }],
  ...(internalBuildState
    ? {
        included: [
          { type: "buildBetaDetails", attributes: { internalBuildState } },
        ],
      }
    : {}),
});

const VALID = listedBuild(
  {
    processingState: "VALID",
    expired: false,
    expirationDate: "2027-01-29T00:21:59-08:00",
    buildAudienceType: "INTERNAL_ONLY",
  },
  "IN_BETA_TESTING",
);

describe("readTestFlightBuildStatus", () => {
  const read = (fetch: typeof globalThis.fetch) =>
    readTestFlightBuildStatus({
      bundleId: "com.example.app",
      shortVersion: "1.6.3",
      bundleVersion: "69",
      apiKey,
      fetch,
    });

  it("reads the app's page and one build, by its version and number", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": VALID,
    });

    await expect(read(fetch)).resolves.toEqual({
      testFlightUrl:
        "https://appstoreconnect.apple.com/apps/6764/testflight/ios",
      status: {
        buildId: "build-1",
        audience: "INTERNAL_ONLY",
        state: "ready",
        expiresAtMs: Date.parse("2027-01-29T00:21:59-08:00"),
      },
    });
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/apps",
      "/v1/builds",
    ]);
    const builds = requests[1]!.query;
    expect(builds.get("filter[app]")).toBe("6764");
    expect(builds.get("filter[version]")).toBe("69");
    expect(builds.get("filter[preReleaseVersion.version]")).toBe("1.6.3");
  });

  it.each([
    ["processing", { processingState: "PROCESSING" }, undefined, "processing"],
    ["no processing state yet", {}, undefined, "processing"],
    ["a failed build", { processingState: "FAILED" }, undefined, "failed"],
    ["an invalid build", { processingState: "INVALID" }, undefined, "failed"],
    [
      "an expired build",
      { processingState: "VALID", expired: true },
      undefined,
      "expired",
    ],
    ["expired in beta", { processingState: "VALID" }, "EXPIRED", "expired"],
    [
      "no compliance answer",
      { processingState: "VALID" },
      "MISSING_EXPORT_COMPLIANCE",
      "missing-compliance",
    ],
    [
      "ready for testing",
      { processingState: "VALID" },
      "READY_FOR_BETA_TESTING",
      "ready",
    ],
  ])("says %s", async (_, attributes, internal, state) => {
    const { fetch } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": listedBuild(attributes, internal),
    });
    const { status } = await read(fetch);
    expect(status?.state).toBe(state);
  });

  it("says nothing of a build App Store Connect no longer lists", async () => {
    const { fetch } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": { data: [] },
    });
    await expect(read(fetch)).resolves.toMatchObject({ status: null });
  });
});

describe("findInternalBetaGroup", () => {
  const find = (fetch: typeof globalThis.fetch, name = "QA") =>
    findInternalBetaGroup({
      bundleId: "com.example.app",
      name,
      apiKey,
      fetch,
    });
  const group = (
    name: string,
    isInternalGroup: boolean,
    hasAccessToAllBuilds = false,
  ) => ({
    id: `group-${name}`,
    attributes: { name, isInternalGroup, hasAccessToAllBuilds },
  });

  it("finds an internal group by its exact name", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/betaGroups": {
        data: [group("QA team", true), group("QA", true, true)],
      },
    });
    await expect(find(fetch)).resolves.toEqual({
      id: "group-QA",
      name: "QA",
      hasAccessToAllBuilds: true,
    });
    expect(requests[1]!.query.get("filter[app]")).toBe("6764");
  });

  it("refuses an external group, changing nothing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/betaGroups": { data: [group("QA", false)] },
    });
    await expect(find(fetch)).rejects.toThrow(
      "TestFlight group QA is external, and a sandbox build is for internal testing only.\nName an internal group.",
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("refuses a group that isn't there, and one that only starts the same", async () => {
    const { fetch } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/betaGroups": { data: [group("QA team", true)] },
    });
    await expect(find(fetch)).rejects.toThrow(
      "App Store Connect has no TestFlight group QA for com.example.app.",
    );
  });
});

describe("distributeTestFlightBuild", () => {
  const build = {
    appId: "6764",
    shortVersion: "1.6.3",
    bundleVersion: "69",
    testFlightUrl: "https://appstoreconnect.apple.com/apps/6764/testflight/ios",
  };
  const group = { id: "group-1", name: "QA", hasAccessToAllBuilds: false };
  const writes = (
    requests: { method: string; path: string; body: unknown }[],
  ) => requests.filter(({ method }) => method !== "GET");

  it("waits for processing, then adds the build to its group and sets What to Test", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/builds": [listedBuild({ processingState: "PROCESSING" }), VALID],
      "POST /v1/betaGroups/group-1/relationships/builds": null,
      "POST /v1/betaBuildLocalizations": { data: { id: "l-1" } },
    });

    await expect(
      distributeTestFlightBuild({
        build,
        group,
        whatToTest: "Native build for #12.",
        apiKey,
        fetch,
        pollIntervalMs: 0,
      }),
    ).resolves.toMatchObject({ state: "ready" });

    expect(writes(requests)).toEqual([
      {
        method: "POST",
        path: "/v1/betaGroups/group-1/relationships/builds",
        query: expect.anything(),
        body: { data: [{ type: "builds", id: "build-1" }] },
      },
      {
        method: "POST",
        path: "/v1/betaBuildLocalizations",
        query: expect.anything(),
        body: {
          data: {
            type: "betaBuildLocalizations",
            attributes: {
              locale: "en-US",
              whatsNew: "Native build for #12.",
            },
            relationships: {
              build: { data: { type: "builds", id: "build-1" } },
            },
          },
        },
      },
    ]);
  });

  it("adds nothing to a group that takes every build", async () => {
    const { fetch, requests } = recordingAsc({ "GET /v1/builds": VALID });
    await distributeTestFlightBuild({
      build,
      group: { ...group, hasAccessToAllBuilds: true },
      apiKey,
      fetch,
    });
    expect(writes(requests)).toEqual([]);
  });

  it("updates the What to Test a rerun finds there", async () => {
    const { fetch, requests } = recordingAsc(
      {
        "GET /v1/builds": VALID,
        "GET /v1/builds/build-1/betaBuildLocalizations": {
          data: [{ id: "l-1", attributes: { locale: "en-US" } }],
        },
        "PATCH /v1/betaBuildLocalizations/l-1": { data: { id: "l-1" } },
      },
      { "POST /v1/betaBuildLocalizations": 409 },
    );
    await distributeTestFlightBuild({
      build,
      whatToTest: "Again.",
      apiKey,
      fetch,
    });
    expect(writes(requests).at(-1)).toMatchObject({
      method: "PATCH",
      path: "/v1/betaBuildLocalizations/l-1",
      body: { data: { attributes: { whatsNew: "Again." } } },
    });
  });

  it("warns and writes nothing while the build is still processing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/builds": listedBuild({ processingState: "PROCESSING" }),
    });
    await expect(
      distributeTestFlightBuild({
        build,
        group,
        whatToTest: "Native build for #12.",
        apiKey,
        fetch,
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({ state: "processing" });
    expect(writes(requests)).toEqual([]);
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("still processing build 1.6.3 (69)"),
    );
  });

  it("fails, writing nothing, when App Store Connect couldn't process it", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/builds": listedBuild({ processingState: "INVALID" }),
    });
    await expect(
      distributeTestFlightBuild({ build, group, apiKey, fetch }),
    ).rejects.toThrow("couldn't process build 1.6.3 (69)");
    expect(writes(requests)).toEqual([]);
  });
});

describe("applyTestFlightGroup", () => {
  const internal = (hasAccessToAllBuilds = false) => ({
    data: [
      {
        id: "group-1",
        attributes: {
          name: "QA",
          isInternalGroup: true,
          hasAccessToAllBuilds,
        },
      },
    ],
  });
  const apply = (
    fetch: typeof globalThis.fetch,
    overrides: Partial<Parameters<typeof applyTestFlightGroup>[0]> = {},
  ) =>
    applyTestFlightGroup({
      bundleId: "com.example.app",
      shortVersion: "1.6.3",
      bundleVersion: "69",
      name: "QA",
      isOffered: (status) => status !== null,
      apiKey,
      fetch,
      pollIntervalMs: 0,
      ...overrides,
    });
  const calls = (requests: { method: string; path: string }[]) =>
    requests.map(({ method, path }) => `${method} ${path}`);

  it("reads the app, the build and the group once each, then adds the build", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": VALID,
      "GET /v1/betaGroups": internal(),
      "POST /v1/betaGroups/group-1/relationships/builds": null,
    });

    await expect(apply(fetch)).resolves.toMatchObject({
      outcome: "added",
      status: { state: "ready" },
    });

    expect(calls(requests)).toEqual([
      "GET /v1/apps",
      "GET /v1/builds",
      "GET /v1/betaGroups",
      "POST /v1/betaGroups/group-1/relationships/builds",
    ]);
    expect(requests.at(-1)?.body).toEqual({
      data: [{ type: "builds", id: "build-1" }],
    });
  });

  it("adds nothing to a group that takes every build, without waiting for processing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": listedBuild({ processingState: "PROCESSING" }),
      "GET /v1/betaGroups": internal(true),
    });
    await expect(apply(fetch)).resolves.toMatchObject({
      outcome: "takes-every-build",
      status: { state: "processing" },
    });
    expect(calls(requests)).toEqual([
      "GET /v1/apps",
      "GET /v1/builds",
      "GET /v1/betaGroups",
    ]);
  });

  it("refuses an external group, writing nothing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": VALID,
      "GET /v1/betaGroups": {
        data: [
          { id: "group-1", attributes: { name: "QA", isInternalGroup: false } },
        ],
      },
    });
    await expect(apply(fetch)).rejects.toThrow(
      "TestFlight group QA is external",
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("refuses a group that isn't there, writing nothing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": VALID,
      "GET /v1/betaGroups": { data: [] },
    });
    await expect(apply(fetch)).rejects.toThrow("has no TestFlight group QA");
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("waits for a build still processing, as an upload does, then adds it", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": [listedBuild({ processingState: "PROCESSING" }), VALID],
      "GET /v1/betaGroups": internal(),
      "POST /v1/betaGroups/group-1/relationships/builds": null,
    });
    await expect(apply(fetch)).resolves.toMatchObject({ outcome: "added" });
    expect(calls(requests)).toEqual([
      "GET /v1/apps",
      "GET /v1/builds",
      "GET /v1/betaGroups",
      "GET /v1/builds",
      "POST /v1/betaGroups/group-1/relationships/builds",
    ]);
  });

  it("warns and writes nothing while the build is still processing", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": listedBuild({ processingState: "PROCESSING" }),
      "GET /v1/betaGroups": internal(),
    });
    await expect(apply(fetch, { timeoutMs: 0 })).resolves.toMatchObject({
      outcome: "pending",
      status: { state: "processing" },
    });
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(p.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("so its testers aren't set"),
    );
  });

  it("fails, writing nothing, when processing fails during the wait", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": [
        listedBuild({ processingState: "PROCESSING" }),
        listedBuild({ processingState: "INVALID" }),
      ],
      "GET /v1/betaGroups": internal(),
    });
    await expect(apply(fetch)).rejects.toThrow(
      "couldn't process build 1.6.3 (69)",
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("reads no group for a build testers can't get", async () => {
    const { fetch, requests } = recordingAsc({
      "GET /v1/apps": APPS,
      "GET /v1/builds": { data: [] },
    });
    await expect(apply(fetch)).resolves.toMatchObject({
      outcome: "not-offered",
      status: null,
    });
    expect(calls(requests)).toEqual(["GET /v1/apps", "GET /v1/builds"]);
  });
});
