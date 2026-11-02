import {
  ReleaseManagementError,
  type Deployment,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import type { CoreApi } from "./core/api";
import { createApi } from "./handler.testFixtures";
import { createAdminRouteHandlers } from "./handlerAdminRoutes";
import { HandlerBadRequestError } from "./handlerErrors";
import type { HandlerAPI } from "./handlerTypes";

const BASE = "http://localhost/hot-updater/admin";

const apiWith = (core: Partial<CoreApi>) => ({ core }) as unknown as HandlerAPI;

const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const deployment: Deployment = {
  bundle: {
    id: "01900000-0000-7000-8000-000000000001",
    platform: "ios",
    gitCommitHash: null,
    manifestStorageUri: "s3://bucket/manifest.json",
    manifestFileHash: "hash",
    assetBaseStorageUri: "s3://bucket/assets",
  },
  release: {
    channel: "production",
    enabled: true,
    fingerprintHash: null,
    message: null,
    shouldForceUpdate: false,
    targetAppVersion: "1.0.x",
  },
};

describe("admin API protocol 2 routes", () => {
  const routes = createAdminRouteHandlers();

  it("deploys well-formed deployments through core", async () => {
    const deploy = vi.fn(async () => []);

    const response = await routes.deployReleases!(
      {},
      post("/releases", { deployments: [deployment] }),
      apiWith({ deploy }),
    );

    expect(response.status).toBe(201);
    expect(deploy).toHaveBeenCalledWith([deployment]);
  });

  it("deploys a stored bundle's new release through core", async () => {
    const deploy = vi.fn(async () => []);
    const stored = {
      bundleId: deployment.bundle.id,
      release: deployment.release,
    };

    const response = await routes.deployReleases!(
      {},
      post("/releases", { deployments: [stored] }),
      apiWith({ deploy }),
    );

    expect(response.status).toBe(201);
    expect(deploy).toHaveBeenCalledWith([stored]);
  });

  it.each([
    ["no deployments", { deployments: [] }],
    [
      "both a bundle and a stored bundle id",
      {
        deployments: [{ ...deployment, bundleId: deployment.bundle.id }],
      },
    ],
    [
      "a bundle without an id",
      {
        deployments: [
          { ...deployment, bundle: { ...deployment.bundle, id: "" } },
        ],
      },
    ],
    [
      "an unknown platform",
      {
        deployments: [
          { ...deployment, bundle: { ...deployment.bundle, platform: "web" } },
        ],
      },
    ],
    [
      "a rollout outside 0–1000 cohorts",
      {
        deployments: [
          {
            ...deployment,
            release: { ...deployment.release, rolloutCohortCount: 1001 },
          },
        ],
      },
    ],
    [
      "a release without its channel",
      {
        deployments: [
          { ...deployment, release: { ...deployment.release, channel: 1 } },
        ],
      },
    ],
  ])("refuses %s before core runs", async (_case, body) => {
    const deploy = vi.fn();

    await expect(
      routes.deployReleases!({}, post("/releases", body), apiWith({ deploy })),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("answers core's refusals with their codes", async () => {
    const promoteRelease = vi.fn(async () => {
      throw new ReleaseManagementError("VERSION_CONFLICT", "changed");
    });

    const response = await routes.promoteRelease!(
      { id: "release-1" },
      post("/releases/release-1/promote", { targetChannel: "beta" }),
      apiWith({ promoteRelease }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "VERSION_CONFLICT",
      error: "changed",
    });
  });

  it("pages releases by key and names the next cursor on a full page", async () => {
    const listReleases = vi.fn(async () => [{ id: "b" }, { id: "a" }]);

    const response = await routes.listReleases!(
      {},
      new Request(`${BASE}/releases?limit=2&channelId=c&platform=ios`),
      apiWith({ listReleases } as unknown as Partial<CoreApi>),
    );

    await expect(response.json()).resolves.toEqual({
      data: [{ id: "b" }, { id: "a" }],
      next: "a",
    });
    expect(listReleases).toHaveBeenCalledWith({
      order: "desc",
      limit: 2,
      filter: { kind: "channelPlatform", channelId: "c", platform: "ios" },
    });
  });

  it.each([
    "bundleId=b&scopeKey=s",
    "channelId=c",
    "bundleId=b&enabled=true",
    "limit=501",
    "order=sideways",
  ])("refuses the release list query %s", async (query) => {
    const listReleases = vi.fn();

    await expect(
      routes.listReleases!(
        {},
        new Request(`${BASE}/releases?${query}`),
        apiWith({ listReleases }),
      ),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
    expect(listReleases).not.toHaveBeenCalled();
  });

  it("finds a native build by scope, answering a scope without one with null data", async () => {
    const findNativeBuild = vi.fn(async () => null);

    const response = await routes.findNativeBuild!(
      {},
      new Request(
        `${BASE}/native-builds/latest?platform=android&channel=beta&appVersion=1.2.0`,
      ),
      apiWith({ findNativeBuild }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });
    expect(findNativeBuild).toHaveBeenCalledWith({
      platform: "android",
      channel: "beta",
      fingerprintHash: null,
      appVersion: "1.2.0",
    });
  });

  it.each([
    "platform=ios&channel=production",
    "platform=ios&channel=production&fingerprintHash=f&appVersion=1.0.0",
    "platform=web&channel=production&fingerprintHash=f",
    "platform=ios&fingerprintHash=f",
  ])("refuses the native build lookup %s", async (query) => {
    const findNativeBuild = vi.fn();

    await expect(
      routes.findNativeBuild!(
        {},
        new Request(`${BASE}/native-builds/latest?${query}`),
        apiWith({ findNativeBuild }),
      ),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
    expect(findNativeBuild).not.toHaveBeenCalled();
  });

  it("registers a well-formed native build, and refuses one with both targets", async () => {
    const registration = {
      id: "01900000-0000-7000-8000-000000000002",
      platform: "ios",
      channel: "production",
      fingerprintHash: "f",
      appVersion: null,
      minBundleId: "01900000-0000-7000-8000-000000000001",
      gitCommitHash: null,
      buildKey: null,
      artifact: { kind: "ipa", storageUri: "s3://bucket/App.ipa", byteSize: 1 },
      embeddedBundle: {
        manifestStorageUri: "s3://bucket/manifest.json",
        manifestFileHash: "hash",
        assetBaseStorageUri: "s3://bucket/assets",
      },
    };
    const registerNativeBuild = vi.fn(async () => ({ id: registration.id }));

    const response = await routes.registerNativeBuild!(
      {},
      post("/native-builds", registration),
      apiWith({ registerNativeBuild } as unknown as Partial<CoreApi>),
    );

    expect(response.status).toBe(201);
    expect(registerNativeBuild).toHaveBeenCalledWith(registration);
    await expect(
      routes.registerNativeBuild!(
        {},
        post("/native-builds", { ...registration, appVersion: "1.0.0" }),
        apiWith({ registerNativeBuild } as unknown as Partial<CoreApi>),
      ),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
    expect(registerNativeBuild).toHaveBeenCalledTimes(1);
  });

  it("deletes a native build, answering an unknown ID with 200 so a 404 means no route", async () => {
    const deleteNativeBuild = vi.fn(async (id: string) =>
      id === "build-1"
        ? { deleted: true, nativeBuild: { id } }
        : { deleted: false, reason: "not_found" },
    );
    const api = apiWith({ deleteNativeBuild } as unknown as Partial<CoreApi>);

    const deleted = await routes.deleteNativeBuild!(
      { id: "build-1" },
      new Request(`${BASE}/native-builds/build-1`, { method: "DELETE" }),
      api,
    );
    const missing = await routes.deleteNativeBuild!(
      { id: "build-2" },
      new Request(`${BASE}/native-builds/build-2`, { method: "DELETE" }),
      api,
    );

    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({
      data: { deleted: true, nativeBuild: { id: "build-1" } },
    });
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({
      data: { deleted: false, reason: "not_found" },
    });
  });

  it("refuses an app version whose scope key overflows, as a bad request", async () => {
    await expect(
      routes.findNativeBuild!(
        {},
        new Request(
          `${BASE}/native-builds/latest?platform=ios&channel=production&appVersion=${encodeURIComponent("한".repeat(300))}`,
        ),
        createApi(),
      ),
    ).rejects.toThrow("longer than 2048 characters");
  });

  it.each([" production", "a".repeat(256)])(
    "refuses the native build channel %j, as a bad request",
    async (channel) => {
      const api = createApi();
      await expect(
        routes.findNativeBuild!(
          {},
          new Request(
            `${BASE}/native-builds/latest?platform=ios&channel=${encodeURIComponent(channel)}&fingerprintHash=f`,
          ),
          api,
        ),
      ).rejects.toBeInstanceOf(HandlerBadRequestError);
      await expect(
        routes.registerNativeBuild!(
          {},
          post("/native-builds", {
            id: "01900000-0000-7000-8000-000000000002",
            platform: "ios",
            channel,
            fingerprintHash: "f",
            appVersion: null,
            minBundleId: "01900000-0000-7000-8000-000000000001",
            gitCommitHash: null,
            buildKey: null,
            artifact: {
              kind: "ipa",
              storageUri: "s3://bucket/App.ipa",
              byteSize: 1,
            },
            embeddedBundle: {
              manifestStorageUri: "s3://bucket/manifest.json",
              manifestFileHash: "hash",
              assetBaseStorageUri: "s3://bucket/assets",
            },
          }),
          api,
        ),
      ).rejects.toBeInstanceOf(HandlerBadRequestError);
      await expect(api.core.listChannels()).resolves.toEqual([]);
    },
  );

  it("refuses a fingerprint core cannot key, as a bad request", async () => {
    await expect(
      routes.findNativeBuild!(
        {},
        new Request(
          `${BASE}/native-builds/latest?platform=ios&channel=production&fingerprintHash=${encodeURIComponent("a/b")}`,
        ),
        createApi(),
      ),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
  });
});
