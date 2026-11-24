import { describe, expect, it, vi } from "vitest";

import { createInsightsAdminReads } from "./adminReads";

const answering = (status: number, body: unknown) =>
  vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json(body, { status }),
  );

describe("createInsightsAdminReads", () => {
  it("reads the routes insights() serves, with each read's query", async () => {
    const fetchAdmin = answering(200, { data: [], nextCursor: null });
    const reads = createInsightsAdminReads(fetchAdmin);

    await reads.getReportingOverview({
      platform: "ios",
      channel: "production",
      window: "7d",
      releaseId: "release-1",
    });
    await reads.listEvents({
      bundle: {
        platform: "android",
        channel: "beta",
        releaseId: "release-2",
        outcome: "recovered",
      },
      limit: 5,
    });
    await reads.listInstallationEvents({ installId: "install/1" });
    await reads.getUpdateFailures({
      platform: "ios",
      channel: "production",
      releaseId: "release-1",
      timeRange: { start: 0, end: 3_600_000 },
    });

    expect(fetchAdmin.mock.calls.map(([path]) => path)).toEqual([
      // The HTTP API calls a release ID bundleId, as users do.
      "/overview?platform=ios&channel=production&window=7d&bundleId=release-1",
      "/events?limit=5&platform=android&channel=beta&bundleId=release-2&outcome=recovered",
      "/installations/install%2F1/events",
      "/failures?platform=ios&channel=production&releaseId=release-1&start=0&end=3600000",
    ]);
  });

  it("reads the overview's bundleId on the wire as its release ID", async () => {
    const counts = { count: 1, measuredAtMs: 10 };
    const reads = createInsightsAdminReads(
      answering(200, {
        platform: "ios",
        channel: "production",
        window: "24h",
        sinceMs: 0,
        beforeReceivedAtMs: 10,
        reportingInstallations: counts,
        bundle: {
          bundleId: "release-1",
          reportingInstallations: counts,
          downloadedReports: counts,
          appliedReports: counts,
          recoveredReports: counts,
          failedReports: counts,
        },
      }),
    );

    const overview = await reads.getReportingOverview({
      platform: "ios",
      channel: "production",
      window: "24h",
      releaseId: "release-1",
    });
    expect(overview.bundle?.releaseId).toBe("release-1");
    expect(overview.bundle).not.toHaveProperty("bundleId");
  });

  it("throws the route's error, or one naming its status", async () => {
    await expect(
      createInsightsAdminReads(
        answering(400, { error: "Invalid reporting installation window." }),
      ).getRetention(),
    ).rejects.toThrow("Invalid reporting installation window.");
    await expect(
      createInsightsAdminReads(answering(503, null)).getRetention(),
    ).rejects.toThrow("The server answered /retention with 503.");
  });

  it("throws the caller's error when the server runs without insights(), and finds no installation", async () => {
    const notFound = answering(404, { error: "Not found" });
    const unavailable = new Error("Not on this server");
    const reads = createInsightsAdminReads(notFound, {
      unavailable: () => unavailable,
    });

    await expect(reads.listEvents({})).rejects.toBe(unavailable);
    await expect(
      reads.getInstallation({ installId: "install-1" }),
    ).resolves.toBe(null);
    await expect(
      createInsightsAdminReads(notFound).getRetention(),
    ).rejects.toThrow("The server runs without insights()");
  });
});
