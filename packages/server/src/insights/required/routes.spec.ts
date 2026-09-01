import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsReportPageInput,
} from "@hot-updater/plugin-core";
import {
  createInsightsReportPageCursor,
  InsightsContractError,
  type RequiredInsightsModel,
} from "@hot-updater/plugin-core/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HotUpdaterSchemaMigrationRequiredError } from "../../db/schemaReadiness";
import type { RouteHandler } from "../../handlerTypes";
import {
  assertRequiredInsightsOperationResult,
  assertRequiredInsightsResult,
  createRequiredInsightsProvider,
} from "./provider";
import { createRequiredInsightsRouteHandlers } from "./routes";

const versions = {
  schemaVersion: "2",
  storageVersion: "2",
  projectionGeneration: "projection-1",
  sourceGeneration: "source-1",
} as const;

const eventVersions = { ...versions, projectionGeneration: null } as const;

const eventRow = (index: number, receivedAtMs: number): BundleEventRow => ({
  id: `019c1680-9e83-7000-8000-${index.toString().padStart(12, "0")}`,
  type: "UNCHANGED",
  install_id: `install-${index}`,
  user_id: null,
  username: null,
  from_release_id: null,
  from_bundle_id: null,
  to_release_id: null,
  to_bundle_id: "bundle-1",
  update_strategy: null,
  platform: "ios",
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  fingerprint_hash: null,
  sdk_version: null,
  received_at_ms: receivedAtMs,
});

const eventPage = (data: readonly BundleEventRow[] = []) => ({
  state: "ready" as const,
  versions: eventVersions,
  data: {
    data,
    nextCursor: null,
    hasNext: false,
    consistency: {
      kind: "live" as const,
      cutoff: { kind: "event-time" as const, beforeReceivedAtMs: 1_000 },
    },
    total: { state: "unavailable" as const },
  },
});

const publication = {
  id: "publication-1",
  asOfMs: 900,
  completedAtMs: 950,
  sourceGeneration: versions.sourceGeneration,
  accuracy: "exact" as const,
};

const liveInstallationPage = {
  state: "ready" as const,
  versions,
  data: {
    data: [],
    nextCursor: null,
    hasNext: false,
    consistency: {
      kind: "live" as const,
      cutoff: {
        kind: "projection" as const,
        observedAtMs: 950,
        projectionGeneration: versions.projectionGeneration,
      },
    },
    total: { state: "unavailable" as const },
  },
};

const installationRow = (installId: string, index = 1) => ({
  id: eventRow(index, index).id,
  install_id: installId,
  user_id: null,
  username: null,
  to_bundle_id: "bundle-1",
  type: "UNCHANGED" as const,
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  cohort: "default",
  received_at_ms: index,
});

const withLiveInstallations = (
  data: readonly ReturnType<typeof installationRow>[],
) => ({
  ...liveInstallationPage,
  data: { ...liveInstallationPage.data, data },
});

const publishedInstallationPage = {
  state: "ready" as const,
  versions,
  data: {
    data: [],
    nextCursor: null,
    hasNext: false,
    consistency: {
      kind: "snapshot" as const,
      cutoff: { kind: "publication" as const, publication },
    },
    total: {
      state: "exact" as const,
      value: 0,
      sourceGeneration: versions.sourceGeneration,
    },
  },
};

const report = {
  state: "ready" as const,
  versions,
  data: {
    ...publication,
    kind: "installationOverview" as const,
    summary: { trackedInstallations: 0 },
  },
};

const reportPage = {
  state: "ready" as const,
  versions,
  data: {
    section: "activeSeries" as const,
    data: [],
    nextCursor: null,
    hasNext: false,
    consistency: {
      kind: "snapshot" as const,
      cutoff: { kind: "publication" as const, publication },
    },
    total: {
      state: "exact" as const,
      value: 0,
      sourceGeneration: versions.sourceGeneration,
    },
  },
};

const createInsightsModel = (): RequiredInsightsModel =>
  ({
    append: vi.fn(),
    pageEvents: vi.fn().mockResolvedValue({
      ...eventPage(),
    }),
    pageInstallations: vi.fn().mockResolvedValue({
      state: "preparing",
      versions,
      job: { id: "installation-job" },
    }),
    getReport: vi.fn().mockResolvedValue({
      state: "preparing",
      versions,
      job: { id: "report-job" },
    }),
    pageReport: vi.fn().mockResolvedValue({
      state: "failed",
      versions,
      error: { code: "index-not-ready" },
    }),
  }) as unknown as RequiredInsightsModel;

const call = (
  handler: RouteHandler | undefined,
  url: string,
  params: Record<string, string> = {},
  init?: RequestInit,
) => handler!(params, new Request(url, init), undefined as never);

afterEach(() => vi.useRealTimers());

describe("required Insights server boundary", () => {
  it("maps every page and report HTTP read to one required model operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const insights = createInsightsModel();
    vi.mocked(insights.pageInstallations)
      .mockResolvedValueOnce({
        state: "preparing",
        versions,
        job: { id: "installation-job" },
      })
      .mockResolvedValueOnce({
        state: "preparing",
        versions,
        job: { id: "installation-job" },
      })
      .mockResolvedValueOnce(publishedInstallationPage);
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const responses = await Promise.all([
      call(handlers.getEventHistory, "https://example.com/events"),
      call(
        handlers.getBundleEventHistory,
        "https://example.com/bundles/bundle-1/events",
        { id: "bundle-1" },
      ),
      call(
        handlers.getEventHistory,
        "https://example.com/events?installId=install-1",
      ),
      call(handlers.getEventHistory, "https://example.com/events?installId="),
      call(
        handlers.searchInstallations,
        "https://example.com/installations?kind=all",
      ),
      call(
        handlers.searchInstallations,
        "https://example.com/installations?kind=contains&query=former-user",
      ),
      call(
        handlers.searchInstallations,
        "https://example.com/installations?kind=userId&userId=former-user&publicationId=publication-1&minAsOfMs=100",
      ),
      call(
        handlers.getBundleEventSummary,
        "https://example.com/bundles/bundle-1/events/summary",
        { id: "bundle-1" },
      ),
      call(
        handlers.getBundleEventInsights,
        "https://example.com/bundles/bundle-1/events/insights?window=7d",
        { id: "bundle-1" },
      ),
      call(
        handlers.getBundleEventOverview,
        "https://example.com/installations/overview",
      ),
      call(
        handlers.getActiveInstallationOverview,
        "https://example.com/installations/active?window=24h&userId=user-1",
      ),
      call(
        handlers.getInsightsReportPage,
        "https://example.com/insights/reports/publication-1?section=movementSeries&metric=installed",
        { publicationId: "publication-1" },
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual(
      Array(12).fill(200),
    );
    expect(insights.pageEvents).toHaveBeenNthCalledWith(1, {
      selector: { kind: "all" },
      beforeReceivedAtMs: 1_000,
      limit: 50,
    });
    expect(insights.pageEvents).toHaveBeenNthCalledWith(2, {
      selector: { kind: "bundleId", bundleId: "bundle-1" },
      beforeReceivedAtMs: 1_000,
      limit: 50,
    });
    expect(insights.pageEvents).toHaveBeenNthCalledWith(3, {
      selector: { kind: "installationId", installId: "install-1" },
      beforeReceivedAtMs: 1_000,
      limit: 50,
    });
    expect(insights.pageEvents).toHaveBeenNthCalledWith(4, {
      selector: { kind: "installationId", installId: "" },
      beforeReceivedAtMs: 1_000,
      limit: 50,
    });
    expect(insights.pageInstallations).toHaveBeenNthCalledWith(1, {
      kind: "all",
      limit: 50,
    });
    expect(insights.pageInstallations).toHaveBeenNthCalledWith(2, {
      kind: "contains",
      query: "former-user",
      limit: 50,
    });
    expect(insights.pageInstallations).toHaveBeenNthCalledWith(3, {
      kind: "userId",
      userId: "former-user",
      publicationId: "publication-1",
      minAsOfMs: 100,
      limit: 50,
    });
    expect(insights.getReport).toHaveBeenNthCalledWith(1, {
      query: {
        kind: "bundleSummaries",
        bundleIds: ["bundle-1"],
        window: "all",
      },
    });
    expect(insights.getReport).toHaveBeenNthCalledWith(2, {
      query: { kind: "bundleDetail", bundleId: "bundle-1", window: "7d" },
    });
    expect(insights.getReport).toHaveBeenNthCalledWith(3, {
      query: { kind: "installationOverview" },
    });
    expect(insights.getReport).toHaveBeenNthCalledWith(4, {
      query: { kind: "activeOverview", window: "24h", userId: "user-1" },
    });
    expect(insights.pageReport).toHaveBeenCalledExactlyOnceWith({
      publicationId: "publication-1",
      section: "movementSeries",
      metric: "installed",
      limit: 50,
    });
  });

  it("rejects offsets, ambiguous inputs and malformed cursors before storage", async () => {
    const insights = createInsightsModel();
    const handlers = createRequiredInsightsRouteHandlers(insights);

    for (const path of [
      "/events?offset=1",
      "/events?cursor=next",
      "/installations",
      "/installations?offset=1",
      "/installations?query=x",
      "/installations?query=",
      "/installations?kind=all&query=",
      "/installations?kind=installationId&installId=install-1&cursor=next",
      "/installations?kind=contains&query=x&query=y",
      "/installations?kind=contains&query=%80",
      "/installations?kind=contains&query=%",
      `/events?beforeReceivedAtMs=1&cursor=${"x".repeat(8_193)}`,
    ]) {
      const handler = path.startsWith("/installations")
        ? handlers.searchInstallations
        : handlers.getEventHistory;
      const response = await call(handler, `https://example.com${path}`);
      expect(response.status, path).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: { code: "INSIGHTS_INVALID_QUERY" },
      });
    }
    expect(insights.pageEvents).not.toHaveBeenCalled();
    expect(insights.pageInstallations).not.toHaveBeenCalled();
  });

  it("decodes route parameters exactly once and rejects malformed encoding", async () => {
    const insights = createInsightsModel();
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const bundle = await call(
      handlers.getBundleEventHistory,
      "https://example.com/bundles/bundle%20one/events?beforeReceivedAtMs=1000",
      { id: "bundle%20one" },
    );
    const percentBundle = await call(
      handlers.getBundleEventHistory,
      "https://example.com/bundles/bundle%2520one/events?beforeReceivedAtMs=1000",
      { id: "bundle%2520one" },
    );
    const report = await call(
      handlers.getInsightsReportPage,
      "https://example.com/insights/reports/publication-%E2%9C%93?section=activeSeries",
      { publicationId: "publication-%E2%9C%93" },
    );
    for (const id of ["%80", "%"]) {
      const malformed = await call(
        handlers.getBundleEventHistory,
        `https://example.com/bundles/${id}/events`,
        { id },
      );
      expect(malformed.status).toBe(400);
    }

    expect(bundle.status).toBe(200);
    expect(percentBundle.status).toBe(200);
    expect(report.status).toBe(200);
    expect(insights.pageEvents).toHaveBeenNthCalledWith(1, {
      selector: { kind: "bundleId", bundleId: "bundle one" },
      beforeReceivedAtMs: expect.any(Number),
      limit: 50,
    });
    expect(insights.pageEvents).toHaveBeenNthCalledWith(2, {
      selector: { kind: "bundleId", bundleId: "bundle%20one" },
      beforeReceivedAtMs: expect.any(Number),
      limit: 50,
    });
    expect(insights.pageEvents).toHaveBeenCalledTimes(2);
    expect(insights.pageReport).toHaveBeenCalledExactlyOnceWith({
      publicationId: "publication-✓",
      section: "activeSeries",
      limit: 50,
    });
  });

  it("accepts only the legal states for each required read operation", () => {
    const preparing = { state: "preparing", versions, job: { id: "job-1" } };
    const failed = {
      state: "failed",
      versions,
      error: { code: "index-not-ready" },
    };
    const expired = { state: "expired", publicationId: "publication-1" };

    for (const [value, kind, limit] of [
      [eventPage(), "live-page", 50],
      [preparing, "live-page", 50],
      [failed, "live-page", 50],
      [publishedInstallationPage, "published-page", 50],
      [
        {
          ...publishedInstallationPage,
          state: "stale",
          refresh: { id: "refresh-1" },
        },
        "published-page",
        50,
      ],
      [preparing, "published-page", 50],
      [failed, "published-page", 50],
      [expired, "published-page", 50],
      [report, "report", undefined],
      [
        { ...report, state: "stale", refresh: { id: "refresh-1" } },
        "report",
        undefined,
      ],
      [preparing, "report", undefined],
      [failed, "report", undefined],
      [reportPage, "report-page", 50],
      [failed, "report-page", 50],
      [expired, "report-page", 50],
    ] as const) {
      expect(() =>
        assertRequiredInsightsResult(value, kind, limit),
      ).not.toThrow();
    }

    for (const [value, kind, limit] of [
      [
        { ...liveInstallationPage, state: "stale", refresh: { id: "job-1" } },
        "live-page",
        50,
      ],
      [expired, "live-page", 50],
      [expired, "report", undefined],
      [preparing, "report-page", 50],
      [
        { state: "failed", versions, error: { code: "preparation-failed" } },
        "report",
        undefined,
      ],
      [eventPage([eventRow(2, 2), eventRow(1, 1)]), "live-page", 1],
    ] as const) {
      expect(() => assertRequiredInsightsResult(value, kind, limit)).toThrow();
    }
  });

  it("binds cutoffs, publications, sections and report IDs to the input", () => {
    expect(() =>
      assertRequiredInsightsOperationResult(eventPage(), {
        kind: "events",
        input: {
          selector: { kind: "all" },
          beforeReceivedAtMs: 1_000,
          limit: 50,
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(publishedInstallationPage, {
        kind: "installations",
        input: {
          kind: "contains",
          query: "user",
          publicationId: publication.id,
          limit: 50,
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(
        {
          ...publishedInstallationPage,
          state: "stale",
          refresh: { id: "refresh-1" },
        },
        {
          kind: "installations",
          input: {
            kind: "contains",
            query: "user",
            publicationId: publication.id,
            cursor: "pinned-cursor",
            limit: 50,
          },
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(reportPage, {
        kind: "report-page",
        input: {
          publicationId: publication.id,
          section: "activeSeries",
          limit: 50,
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertRequiredInsightsOperationResult(eventPage(), {
        kind: "events",
        input: {
          selector: { kind: "all" },
          beforeReceivedAtMs: 999,
          limit: 50,
        },
      }),
    ).toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(publishedInstallationPage, {
        kind: "installations",
        input: {
          kind: "contains",
          query: "user",
          publicationId: "other-publication",
          limit: 50,
        },
      }),
    ).toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(report, {
        kind: "report",
        input: {
          query: { kind: "activeOverview", window: "24h" },
        },
      }),
    ).toThrow();
    expect(() =>
      assertRequiredInsightsOperationResult(reportPage, {
        kind: "report-page",
        input: {
          publicationId: publication.id,
          section: "bundleDistribution",
          limit: 50,
        },
      }),
    ).toThrow();
  });

  it("fails closed when provider data does not belong to the request", async () => {
    const update = (installId: string, toBundleId: string) => ({
      ...eventRow(1, 900),
      type: "UPDATE_APPLIED" as const,
      install_id: installId,
      from_bundle_id: "bundle-old",
      to_bundle_id: toBundleId,
      update_strategy: "appVersion" as const,
    });
    const recovered = (
      installId: string,
      fromBundleId: string,
      toBundleId: string,
    ) => ({
      ...eventRow(1, 900),
      type: "RECOVERED" as const,
      install_id: installId,
      from_bundle_id: fromBundleId,
      to_bundle_id: toBundleId,
      update_strategy: "appVersion" as const,
    });
    const activeBundlePage = {
      ...reportPage,
      data: {
        ...reportPage.data,
        section: "activeBundleSeries" as const,
        data: [{ bundleId: "bundle-other", bucketStartMs: 0, value: 1 }],
        total: { ...reportPage.data.total, value: 1 },
      },
    };
    const scenarios = [
      {
        method: "pageEvents" as const,
        result: eventPage([eventRow(1, 100)]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?sinceReceivedAtMs=200&beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([eventRow(1, 1_000)]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: {
          ...eventPage(),
          data: {
            ...eventPage().data,
            nextCursor: "same-cursor",
            hasNext: true,
          },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?beforeReceivedAtMs=1000&cursor=same-cursor",
          ),
      },
      {
        method: "pageEvents" as const,
        result: {
          ...eventPage(),
          data: {
            ...eventPage().data,
            total: {
              state: "exact" as const,
              value: 5,
              sourceGeneration: eventVersions.sourceGeneration,
            },
          },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: {
          ...eventPage(),
          data: { ...eventPage().data, nextCursor: "", hasNext: true },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: {
          ...eventPage([eventRow(1, 900)]),
          data: {
            ...eventPage([eventRow(1, 900)]).data,
            total: {
              state: "exact" as const,
              value: 0,
              sourceGeneration: versions.sourceGeneration,
            },
          },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([update("install-other", "bundle-1")]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?installId=install-1&beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([eventRow(1, 900)]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getEventHistory,
            "https://example.com/events?installId=install-1&beforeReceivedAtMs=1000",
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([update("install-1", "bundle-other")]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getBundleEventHistory,
            "https://example.com/bundles/bundle-1/events?beforeReceivedAtMs=1000",
            { id: "bundle-1" },
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([
          {
            ...update("install-1", "bundle-other"),
            from_bundle_id: "bundle-1",
          },
        ]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getBundleEventHistory,
            "https://example.com/bundles/bundle-1/events?beforeReceivedAtMs=1000",
            { id: "bundle-1" },
          ),
      },
      {
        method: "pageEvents" as const,
        result: eventPage([recovered("install-1", "bundle-other", "bundle-1")]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getBundleEventHistory,
            "https://example.com/bundles/bundle-1/events?beforeReceivedAtMs=1000",
            { id: "bundle-1" },
          ),
      },
      {
        method: "pageInstallations" as const,
        result: withLiveInstallations([installationRow("install-other")]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=installationId&installId=install-1",
          ),
      },
      {
        method: "pageInstallations" as const,
        result: {
          ...withLiveInstallations([installationRow("install-1")]),
          data: {
            ...withLiveInstallations([installationRow("install-1")]).data,
            nextCursor: "unexpected-successor",
            hasNext: true,
          },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=installationId&installId=install-1",
          ),
      },
      {
        method: "pageInstallations" as const,
        result: withLiveInstallations([
          installationRow("", 1),
          installationRow("", 2),
        ]),
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=installationId&installId=",
          ),
      },
      {
        method: "pageInstallations" as const,
        result: publishedInstallationPage,
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=contains&query=user&minAsOfMs=1000",
          ),
      },
      {
        method: "getReport" as const,
        result: report,
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getBundleEventOverview,
            "https://example.com/installations/overview?minAsOfMs=1000",
          ),
      },
      {
        method: "pageInstallations" as const,
        result: { state: "preparing", versions, job: { id: "job-1" } },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=userId&userId=user&publicationId=publication-1",
          ),
      },
      {
        method: "pageInstallations" as const,
        result: {
          ...publishedInstallationPage,
          state: "stale",
          refresh: { id: "refresh-1" },
        },
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.searchInstallations,
            "https://example.com/installations?kind=contains&query=user&publicationId=publication-1",
          ),
      },
      {
        method: "pageReport" as const,
        result: activeBundlePage,
        invoke: (handlers: Record<string, RouteHandler>) =>
          call(
            handlers.getInsightsReportPage,
            "https://example.com/insights/reports/publication-1?section=activeBundleSeries&bundleId=bundle-1",
            { publicationId: "publication-1" },
          ),
      },
    ];

    for (const scenario of scenarios) {
      const insights = createInsightsModel();
      const storage = insights[scenario.method];
      vi.mocked(storage).mockResolvedValueOnce(scenario.result as never);
      const response = await scenario.invoke(
        createRequiredInsightsRouteHandlers(insights),
      );
      expect(response.status, scenario.method).toBe(500);
      expect(storage).toHaveBeenCalledOnce();
    }
  });

  it("rejects invalid provider states and pages above the requested limit", async () => {
    const insights = createInsightsModel();
    const handlers = createRequiredInsightsRouteHandlers(insights);
    vi.mocked(insights.pageEvents)
      .mockResolvedValueOnce({
        ...eventPage(),
        state: "stale",
        refresh: { id: "refresh-1" },
      } as never)
      .mockResolvedValueOnce(eventPage([eventRow(2, 2), eventRow(1, 1)]));
    vi.mocked(insights.getReport).mockResolvedValueOnce({
      state: "expired",
      publicationId: "publication-1",
    } as never);
    vi.mocked(insights.pageReport).mockResolvedValueOnce({
      state: "preparing",
      versions,
      job: { id: "job-1" },
    } as never);

    const responses = await Promise.all([
      call(handlers.getEventHistory, "https://example.com/events"),
      call(handlers.getEventHistory, "https://example.com/events?limit=1"),
      call(
        handlers.getBundleEventOverview,
        "https://example.com/installations/overview",
      ),
      call(
        handlers.getInsightsReportPage,
        "https://example.com/insights/reports/publication-1?section=activeSeries",
        { publicationId: "publication-1" },
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual(
      Array(4).fill(500),
    );
  });

  it("does not serialize a provider page above the one-megabyte response bound", async () => {
    const insights = createInsightsModel();
    vi.mocked(insights.pageEvents).mockResolvedValueOnce({
      state: "ready",
      versions: eventVersions,
      data: {
        data: Array.from({ length: 100 }, (_, index) => ({
          ...eventRow(index, 999 - index),
          a: "a".repeat(1_024),
          b: "b".repeat(1_024),
          c: "c".repeat(1_024),
          d: "d".repeat(1_024),
          e: "e".repeat(1_024),
          f: "f".repeat(1_024),
          g: "g".repeat(1_024),
          h: "h".repeat(1_024),
          i: "i".repeat(1_024),
          j: "j".repeat(1_024),
          k: "k".repeat(1_024),
        })) as readonly BundleEventRow[],
        nextCursor: null,
        hasNext: false,
        consistency: {
          kind: "live",
          cutoff: { kind: "event-time", beforeReceivedAtMs: 1_000 },
        },
        total: { state: "unavailable" },
      },
    });
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const response = await call(
      handlers.getEventHistory,
      "https://example.com/events?beforeReceivedAtMs=1000",
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INSIGHTS_QUERY_FAILED" },
    });
  });

  it("treats provider event-size failures on reads as storage failures", async () => {
    const insights = createInsightsModel();
    vi.mocked(insights.pageEvents).mockRejectedValueOnce(
      new InsightsContractError("event-too-large"),
    );
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const response = await call(
      handlers.getEventHistory,
      "https://example.com/events",
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INSIGHTS_QUERY_FAILED" },
    });
  });

  it("returns typed readiness failures as data and reserves 503 for fixed schema preflight", async () => {
    const insights = createInsightsModel();
    const unknownVersions = {
      schemaVersion: null,
      storageVersion: null,
      projectionGeneration: null,
      sourceGeneration: null,
    } as const;
    vi.mocked(insights.pageEvents)
      .mockResolvedValueOnce({
        state: "failed",
        versions: eventVersions,
        error: { code: "schema-not-ready" },
      })
      .mockResolvedValueOnce({
        state: "failed",
        versions: eventVersions,
        error: { code: "source-not-ready" },
      })
      .mockRejectedValueOnce(
        new HotUpdaterSchemaMigrationRequiredError("test", undefined),
      );
    vi.mocked(insights.pageInstallations).mockResolvedValueOnce({
      state: "failed",
      versions: unknownVersions,
      error: { code: "source-not-ready" },
    });
    vi.mocked(insights.getReport).mockResolvedValueOnce({
      state: "failed",
      versions: unknownVersions,
      error: { code: "source-not-ready" },
    });
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const schema = await call(
      handlers.getEventHistory,
      "https://example.com/events",
    );
    const source = await call(
      handlers.getEventHistory,
      "https://example.com/events",
    );
    const fixedSchema = await call(
      handlers.getEventHistory,
      "https://example.com/events",
    );
    const installationSource = await call(
      handlers.searchInstallations,
      "https://example.com/installations?kind=all",
    );
    const reportSource = await call(
      handlers.getBundleEventOverview,
      "https://example.com/installations/overview",
    );

    expect(schema.status).toBe(200);
    await expect(schema.json()).resolves.toMatchObject({
      state: "failed",
      error: { code: "schema-not-ready" },
    });
    expect(source.status).toBe(200);
    await expect(source.json()).resolves.toMatchObject({
      state: "failed",
      error: { code: "source-not-ready" },
    });
    expect(fixedSchema.status).toBe(503);
    await expect(fixedSchema.json()).resolves.toEqual({
      error: { code: "INSIGHTS_SCHEMA_MIGRATION_REQUIRED" },
    });
    for (const response of [installationSource, reportSource]) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        state: "failed",
        versions: unknownVersions,
        error: { code: "source-not-ready" },
      });
    }
  });

  it("accepts cursor-pinned expiry and surfaces wrong-query cursors as invalid", async () => {
    const expired = {
      state: "expired" as const,
      publicationId: "cursor-publication",
    };
    const insights = createInsightsModel();
    vi.mocked(insights.pageInstallations)
      .mockResolvedValueOnce(expired)
      .mockRejectedValueOnce(new DatabasePluginInputError("invalid-query"))
      .mockResolvedValueOnce({
        ...publishedInstallationPage,
        state: "stale",
        refresh: { id: "refresh-1" },
      })
      .mockResolvedValueOnce({
        state: "preparing",
        versions,
        job: { id: "job-1" },
      });
    const handlers = createRequiredInsightsRouteHandlers(insights);

    const cursorExpiry = await call(
      handlers.searchInstallations,
      "https://example.com/installations?kind=contains&query=user&cursor=pinned-cursor",
    );
    const wrongQuery = await call(
      handlers.searchInstallations,
      "https://example.com/installations?kind=contains&query=other-user&cursor=pinned-cursor",
    );
    const staleContinuation = await call(
      handlers.searchInstallations,
      "https://example.com/installations?kind=contains&query=user&cursor=pinned-cursor",
    );
    const preparingContinuation = await call(
      handlers.searchInstallations,
      "https://example.com/installations?kind=contains&query=user&cursor=pinned-cursor",
    );

    expect(cursorExpiry.status).toBe(200);
    await expect(cursorExpiry.json()).resolves.toEqual(expired);
    expect(wrongQuery.status).toBe(400);
    await expect(wrongQuery.json()).resolves.toEqual({
      error: { code: "INSIGHTS_INVALID_QUERY" },
    });
    expect(staleContinuation.status).toBe(200);
    await expect(staleContinuation.json()).resolves.toMatchObject({
      state: "stale",
      refresh: { id: "refresh-1" },
    });
    expect(preparingContinuation.status).toBe(500);
    expect(insights.pageInstallations).toHaveBeenCalledTimes(4);

    const model = createInsightsModel();
    vi.mocked(model.pageInstallations).mockResolvedValueOnce(expired);
    const beforeOperation = vi.fn().mockResolvedValue(undefined);
    const provider = createRequiredInsightsProvider(model, beforeOperation);
    await expect(
      provider.pageInstallations({
        kind: "contains",
        query: "user",
        limit: 50,
        cursor: "pinned-cursor",
      }),
    ).resolves.toEqual(expired);
    expect(beforeOperation).toHaveBeenCalledOnce();
    expect(model.pageInstallations).toHaveBeenCalledOnce();
  });

  it("validates UTF-8, creates a canonical UUIDv7 row and uses append only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const insights = createInsightsModel();
    const handlers = createRequiredInsightsRouteHandlers(insights);
    const valid = JSON.stringify({
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprintHash: null,
      fromBundleId: null,
      fromReleaseId: null,
      installId: "install-1",
      platform: "ios",
      sdkVersion: "2.0.0",
      toBundleId: "bundle-1",
      toReleaseId: null,
      type: "UNCHANGED",
      updateStrategy: null,
    });

    const accepted = await call(
      handlers.appendBundleEvent,
      "https://example.com/events",
      {},
      { method: "POST", body: valid },
    );
    const acceptedEmptyInstallId = await call(
      handlers.appendBundleEvent,
      "https://example.com/events",
      {},
      {
        method: "POST",
        body: JSON.stringify({ ...JSON.parse(valid), installId: "" }),
      },
    );
    const malformed = await call(
      handlers.appendBundleEvent,
      "https://example.com/events",
      {},
      { method: "POST", body: new Uint8Array([0x7b, 0x80, 0x7d]) },
    );
    const loneSurrogate = await call(
      handlers.appendBundleEvent,
      "https://example.com/events",
      {},
      {
        method: "POST",
        body: JSON.stringify({ ...JSON.parse(valid), installId: "\ud800" }),
      },
    );
    const oversized = await call(
      handlers.appendBundleEvent,
      "https://example.com/events",
      {},
      {
        method: "POST",
        body: JSON.stringify({
          ...JSON.parse(valid),
          installId: "a".repeat(16 * 1_024),
        }),
      },
    );

    expect(accepted.status).toBe(204);
    expect(acceptedEmptyInstallId.status).toBe(204);
    expect(malformed.status).toBe(400);
    expect(loneSurrogate.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(insights.append).toHaveBeenCalledTimes(2);
    const row = vi.mocked(insights.append).mock.calls[0]?.[0] as BundleEventRow;
    expect(row).toMatchObject({
      install_id: "install-1",
      received_at_ms: Date.parse("2026-08-12T00:00:00.000Z"),
      type: "UNCHANGED",
    });
    expect(row.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(vi.mocked(insights.append).mock.calls[1]?.[0]).toMatchObject({
      install_id: "",
    });
  });

  it("checks readiness before each required model operation", async () => {
    const model = createInsightsModel();
    const beforeOperation = vi.fn().mockResolvedValue(undefined);
    const provider = createRequiredInsightsProvider(model, beforeOperation);
    const row = {
      id: "019c1680-9e83-7000-8000-000000000001",
      type: "UNCHANGED",
      install_id: "install-1",
      user_id: null,
      username: null,
      from_release_id: null,
      from_bundle_id: null,
      to_release_id: null,
      to_bundle_id: "bundle-1",
      update_strategy: null,
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      cohort: "default",
      fingerprint_hash: null,
      sdk_version: null,
      received_at_ms: 1,
    } as BundleEventRow;

    await provider.append(row);
    await provider.pageEvents({
      selector: { kind: "all" },
      beforeReceivedAtMs: 1_000,
      limit: 1,
    });
    await provider.pageInstallations({ kind: "all", limit: 1 });
    await provider.getReport({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["bundle-b", "bundle-a", "bundle-b"],
        window: "all",
      },
    });
    await provider.pageReport({
      publicationId: "publication-1",
      section: "activeSeries",
      limit: 1,
    });
    await expect(
      provider.pageEvents({
        selector: { kind: "all" },
        beforeReceivedAtMs: 1,
        limit: 0,
      }),
    ).rejects.toMatchObject({ name: "DatabasePluginInputError" });
    await expect(
      // @ts-expect-error exact installation point reads forbid cursors
      provider.pageInstallations({
        kind: "installationId",
        installId: "install-1",
        limit: 1,
        cursor: "next",
      }),
    ).rejects.toMatchObject({ name: "DatabasePluginInputError" });

    expect(beforeOperation).toHaveBeenCalledTimes(5);
    expect(model.append).toHaveBeenCalledWith(row);
    expect(model.pageInstallations).toHaveBeenCalledOnce();
    expect(model.getReport).toHaveBeenCalledExactlyOnceWith({
      query: {
        kind: "bundleSummaries",
        bundleIds: ["bundle-a", "bundle-b"],
        window: "all",
      },
    });
  });

  it("rejects malformed report pages before readiness and forwards provider cursors", async () => {
    const model = createInsightsModel();
    const beforeOperation = vi.fn().mockResolvedValue(undefined);
    const provider = createRequiredInsightsProvider(model, beforeOperation);
    const input = {
      publicationId: "publication-1",
      section: "activeSeries" as const,
      limit: 1,
    };
    const cursor = createInsightsReportPageCursor(
      input,
      "1",
      "provider-durable-namespace",
    );

    for (const malformed of [
      { ...input, limit: 0 },
      { ...input, cursor: "not-json" },
      { ...input, cursor, publicationId: "publication-2" },
      { ...input, offset: 0 },
    ]) {
      await expect(
        provider.pageReport(malformed as InsightsReportPageInput),
      ).rejects.toMatchObject({ name: "DatabasePluginInputError" });
    }
    expect(beforeOperation).not.toHaveBeenCalled();
    expect(model.pageReport).not.toHaveBeenCalled();

    await expect(
      provider.pageReport({ ...input, cursor }),
    ).resolves.toMatchObject({ state: "failed" });
    expect(beforeOperation).toHaveBeenCalledOnce();
    expect(model.pageReport).toHaveBeenCalledExactlyOnceWith({
      ...input,
      cursor,
    });
  });
});
