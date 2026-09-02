import { describe, expect, it } from "vitest";

import hotUpdaterConfig from "./hot-updater.config";

describe("Console demo Insights configuration", () => {
  it("loads valid event fixtures and prepared demo reads", async () => {
    const events = await hotUpdaterConfig.database.models.insights.pageEvents({
      beforeReceivedAtMs: Number.MAX_SAFE_INTEGER,
      limit: 50,
      selector: { kind: "all" },
    });
    expect(events).toMatchObject({
      state: "ready",
      data: {
        data: expect.arrayContaining([
          expect.objectContaining({ type: "UNCHANGED" }),
        ]),
      },
    });

    const search =
      await hotUpdaterConfig.database.models.insights.pageInstallations({
        kind: "contains",
        limit: 20,
        query: "demo",
      });
    expect(search).toMatchObject({
      state: "ready",
      data: { total: { state: "exact", value: 6 } },
    });

    const report = await hotUpdaterConfig.database.models.insights.getReport({
      query: { kind: "activeOverview", window: "30d" },
    });
    expect(report).toMatchObject({
      state: "ready",
      data: {
        kind: "activeOverview",
        summary: { activeInstallations: 8 },
      },
    });
  });
});
