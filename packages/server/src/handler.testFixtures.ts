import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { vi } from "vitest";

import { createHandler, type HandlerAPI, type HandlerRoutes } from "./handler";

export const NEXT_SDK_VERSION_FOR_TEST = "0.31.0";
export const CURRENT_PACKAGE_SDK_VERSION = "0.30.10";

type TestEnv = {
  tenantId: string;
};

export type TestContext = {
  env: TestEnv;
};

export const testBundle: Bundle = {
  id: "bundle-1",
  platform: "ios",
  shouldForceUpdate: false,
  enabled: true,
  fileHash: "hash123",
  gitCommitHash: null,
  message: "Test bundle",
  channel: "production",
  storageUri: "s3://test-bucket/bundles/bundle-1.zip",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
};

export const testEventPayload = {
  type: "UPDATE_APPLIED",
  installId: "install-1",
  fromBundleId: "bundle-0",
  toBundleId: "bundle-1",
  platform: "ios",
  appVersion: "1.0.0",
  channel: "production",
  cohort: "default",
  updateStrategy: "appVersion",
  fingerprintHash: null,
};

export const createApi = () =>
  ({
    getAppUpdateInfo: vi
      .fn<HandlerAPI<TestContext>["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI<TestContext>["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI<TestContext>["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI<TestContext>["getChannels"]>()
      .mockResolvedValue(["production"]),
    insertBundle: vi.fn<HandlerAPI<TestContext>["insertBundle"]>(),
    updateBundleById: vi.fn<HandlerAPI<TestContext>["updateBundleById"]>(),
    deleteBundleById: vi.fn<HandlerAPI<TestContext>["deleteBundleById"]>(),
    appendBundleEvent:
      vi.fn<NonNullable<HandlerAPI<TestContext>["appendBundleEvent"]>>(),
    getBundleEventSummary: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventSummary"]>>()
      .mockResolvedValue({ installed: 0, recovered: 0 }),
    getBundleEventAnalytics: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventAnalytics"]>>()
      .mockResolvedValue({
        summary: { installed: 0, recovered: 0 },
        series: { installed: [], recovered: [] },
        cohorts: { installed: [], recovered: [] },
        recentEvents: {
          data: [],
          pagination: { total: 0, limit: 50, offset: 0 },
        },
      }),
    getBundleEventOverview: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getBundleEventOverview"]>>()
      .mockResolvedValue({ trackedInstallations: 0, bundles: [] }),
    getActiveInstallationOverview: vi
      .fn<
        NonNullable<HandlerAPI<TestContext>["getActiveInstallationOverview"]>
      >()
      .mockResolvedValue({
        asOfMs: 0,
        window: "30d",
        activeInstallations: 0,
        series: [],
        bundles: [],
      }),
    searchInstallations: vi
      .fn<NonNullable<HandlerAPI<TestContext>["searchInstallations"]>>()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
    getInstallationHistory: vi
      .fn<NonNullable<HandlerAPI<TestContext>["getInstallationHistory"]>>()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
  }) satisfies HandlerAPI<TestContext>;

export const createManagementHandler = (
  api: HandlerAPI<TestContext>,
  routes: Partial<HandlerRoutes> = {},
) =>
  createHandler(api, {
    basePath: "/hot-updater",
    eventIngestion: { authorize: () => true },
    routes: {
      updateCheck: true,
      bundles: true,
      ...routes,
    },
  });
