import { NIL_UUID } from "@hot-updater/core";
import { vi } from "vitest";

import type { HandlerAPI, HandlerRoutes } from "./handler";
import { createHandler } from "./handler";

export type HandlerTestContext = {
  readonly requestId: string;
};

export const createAnalyticsHandlerApi = () =>
  ({
    getAppUpdateInfo: vi
      .fn<HandlerAPI<HandlerTestContext>["getAppUpdateInfo"]>()
      .mockResolvedValue({
        fileHash: null,
        fileUrl: null,
        id: NIL_UUID,
        message: null,
        shouldForceUpdate: true,
        status: "ROLLBACK",
      }),
    getBundleById: vi.fn<HandlerAPI<HandlerTestContext>["getBundleById"]>(),
    getBundles: vi.fn<HandlerAPI<HandlerTestContext>["getBundles"]>(),
    getChannels: vi
      .fn<HandlerAPI<HandlerTestContext>["getChannels"]>()
      .mockResolvedValue([]),
    insertBundle: vi.fn<HandlerAPI<HandlerTestContext>["insertBundle"]>(),
    updateBundleById:
      vi.fn<HandlerAPI<HandlerTestContext>["updateBundleById"]>(),
    deleteBundleById:
      vi.fn<HandlerAPI<HandlerTestContext>["deleteBundleById"]>(),
    appendBundleEvent:
      vi.fn<NonNullable<HandlerAPI<HandlerTestContext>["appendBundleEvent"]>>(),
    getBundleEventSummary: vi
      .fn<
        NonNullable<HandlerAPI<HandlerTestContext>["getBundleEventSummary"]>
      >()
      .mockResolvedValue({ installed: 0, recovered: 0 }),
    getBundleEventAnalytics: vi
      .fn<
        NonNullable<HandlerAPI<HandlerTestContext>["getBundleEventAnalytics"]>
      >()
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
      .fn<
        NonNullable<HandlerAPI<HandlerTestContext>["getBundleEventOverview"]>
      >()
      .mockResolvedValue({ trackedInstallations: 0, bundles: [] }),
    getActiveInstallationOverview: vi
      .fn<
        NonNullable<
          HandlerAPI<HandlerTestContext>["getActiveInstallationOverview"]
        >
      >()
      .mockResolvedValue({
        asOfMs: 1_752_754_600_000,
        window: "30d",
        activeInstallations: 0,
        series: [],
        bundles: [],
      }),
    searchInstallations: vi
      .fn<NonNullable<HandlerAPI<HandlerTestContext>["searchInstallations"]>>()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
    getInstallationHistory: vi
      .fn<
        NonNullable<HandlerAPI<HandlerTestContext>["getInstallationHistory"]>
      >()
      .mockResolvedValue({
        data: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      }),
  }) satisfies HandlerAPI<HandlerTestContext>;

export const createAnalyticsHandler = (
  api: HandlerAPI<HandlerTestContext>,
  routes: HandlerRoutes = { updateCheck: true, bundles: true },
) =>
  createHandler(api, {
    basePath: "/hot-updater",
    routes,
  });
