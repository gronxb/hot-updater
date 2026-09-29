import {
  ReleaseManagementError,
  type Deployment,
  type HotUpdaterCoreApi,
} from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  adminV2Reads,
  createAdminV2RouteHandlers,
} from "./handlerAdminV2Routes";
import { HandlerBadRequestError } from "./handlerErrors";
import type { HandlerAPI } from "./handlerTypes";

const BASE = "http://localhost/hot-updater/admin";

const apiWith = (core: Partial<HotUpdaterCoreApi> | undefined) =>
  ({ core }) as unknown as HandlerAPI;

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
  const routes = createAdminV2RouteHandlers();

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

  it.each([
    ["no deployments", { deployments: [] }],
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

  it("answers 404 on a database that is not on the storage engine", async () => {
    const response = await routes.deployReleases!(
      {},
      post("/releases", { deployments: [deployment] }),
      apiWith(undefined),
    );

    expect(response.status).toBe(404);
  });

  it("pages releases by key and names the next cursor on a full page", async () => {
    const listReleases = vi.fn(async () => [{ id: "b" }, { id: "a" }]);

    const response = await adminV2Reads.listReleases(
      {},
      new Request(`${BASE}/releases?v=2&limit=2&channelId=c&platform=ios`),
      apiWith({ listReleases } as unknown as Partial<HotUpdaterCoreApi>),
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
      adminV2Reads.listReleases(
        {},
        new Request(`${BASE}/releases?v=2&${query}`),
        apiWith({ listReleases }),
      ),
    ).rejects.toBeInstanceOf(HandlerBadRequestError);
    expect(listReleases).not.toHaveBeenCalled();
  });
});
