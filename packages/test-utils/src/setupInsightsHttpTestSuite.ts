import { describe, expect, it } from "vitest";

import { jsonRequest } from "./adminApiTestClient";
import { expectInsightsIndex } from "./expectInsightsIndex";
import type { HttpTestClient } from "./httpTestClient";

type InstallationPage = {
  readonly data: readonly {
    readonly installId: string;
    readonly lastKnownBundleId: string;
    readonly latestStatus: string;
  }[];
};

/**
 * The Insights plugin's routes on a database: a client reports an event, and
 * the admin routes read it back. The server must run `insights()`.
 */
export const setupInsightsHttpTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Insights HTTP routes", () => {
    it("records a reported event and reads it back", async () => {
      const client = options.getClient();
      const installId = `install-${crypto.randomUUID()}`;
      const userId = `user-${crypto.randomUUID()}`;
      const channel = `insights-${crypto.randomUUID()}`;
      const event = {
        appVersion: "1.0.0",
        channel,
        cohort: "default",
        fingerprintHash: null,
        fromBundleId: null,
        fromReleaseId: null,
        installId,
        platform: "ios",
        toBundleId: "00000000-0000-7000-8000-000000000001",
        toReleaseId: null,
        type: "UNCHANGED",
        updateStrategy: null,
        userId,
        username: "Jane",
        sdkVersion: "2.0.0",
      };

      const reported = await client.client(
        "/events",
        jsonRequest("POST", event),
      );
      expect(reported.status).toBe(204);
      expect(reported.headers.get("x-hot-updater-insights")).toBeNull();
      await reported.text();

      const installation = await client.admin(
        `/installations/${encodeURIComponent(installId)}`,
      );
      expect(installation.status).toBe(200);
      expect(await installation.json()).toMatchObject({
        installId,
        latestStatus: "UNCHANGED",
        lastKnownBundleId: event.toBundleId,
        channel,
      });
      await expectInsightsIndex(async () => {
        const page = await client.admin(
          `/installations?userId=${encodeURIComponent(userId)}`,
        );
        return ((await page.json()) as InstallationPage).data.map(
          ({ installId: id }) => id,
        );
      }, [installId]);
      await expectInsightsIndex(async () => {
        const overview = await client.admin(
          `/overview?platform=ios&channel=${encodeURIComponent(channel)}&window=24h`,
        );
        return (
          (await overview.json()) as {
            readonly reportingInstallations: { readonly count: number };
          }
        ).reportingInstallations.count;
      }, 1);
    });

    it("refuses a malformed event", async () => {
      const response = await options
        .getClient()
        .client("/events", jsonRequest("POST", { type: "UNCHANGED" }));

      expect(response.status).toBe(400);
      await response.text();
    });
  });
};
