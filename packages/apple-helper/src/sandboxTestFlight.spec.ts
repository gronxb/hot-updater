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
  assertBuildIsInternalOnly,
  assertIpaIsInternalOnly,
  prepareSandboxArchive,
  readAppStoreTrain,
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

  it("refuses before the build under appVersion when the version is closed", async () => {
    await expect(
      prepareSandboxArchive({
        schemeConfig: scheme(),
        apiKey,
        updateStrategy: "appVersion",
        appVersion: "1.6.2",
        fetch: asc(closed162).fetch,
      }),
    ).rejects.toThrow(
      "App Store Connect closed version 1.6.2, so TestFlight refuses 1.6.2.\nRaise the app version.",
    );
  });

  it("builds under appVersion when the version is open", async () => {
    expect(
      await prepareSandboxArchive({
        schemeConfig: scheme(),
        apiKey,
        updateStrategy: "appVersion",
        appVersion: "1.7.0",
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
        appVersion: null,
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
        appVersion: null,
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
