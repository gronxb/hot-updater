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
 * the admin routes read it back and delete it. The server must run
 * `insights()`.
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

    it("deletes an installation's, then a user's, data through the admin routes", async () => {
      const client = options.getClient();
      const userId = `user-${crypto.randomUUID()}`;
      const channel = `insights-${crypto.randomUUID()}`;
      const installs = [0, 1, 2].map(() => `install-${crypto.randomUUID()}`);
      for (const installId of installs) {
        const reported = await client.client(
          "/events",
          jsonRequest("POST", {
            appVersion: "1.0.0",
            channel,
            cohort: "default",
            fingerprintHash: null,
            fromBundleId: "00000000-0000-7000-8000-000000000001",
            fromReleaseId: null,
            installId,
            platform: "ios",
            toBundleId: "00000000-0000-7000-8000-000000000002",
            toReleaseId: null,
            type: "UPDATE_APPLIED",
            updateStrategy: "appVersion",
            userId,
          }),
        );
        expect(reported.status).toBe(204);
        await reported.text();
      }
      const history = (installId: string) => async () => {
        const page = await client.admin(
          `/installations/${encodeURIComponent(installId)}/events?limit=10`,
        );
        return ((await page.json()) as { readonly data: unknown[] }).data
          .length;
      };
      const userInstalls = async () => {
        const page = await client.admin(
          `/installations?userId=${encodeURIComponent(userId)}`,
        );
        return ((await page.json()) as InstallationPage).data
          .map(({ installId }) => installId)
          .sort();
      };
      for (const installId of installs) {
        await expectInsightsIndex(history(installId), 1);
      }
      await expectInsightsIndex(userInstalls, [...installs].sort());

      const one = await client.admin(
        `/installations/${encodeURIComponent(installs[0]!)}`,
        { method: "DELETE" },
      );
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({
        deleted: { installations: 1, events: 1 },
        complete: true,
      });
      const gone = await client.admin(
        `/installations/${encodeURIComponent(installs[0]!)}`,
      );
      expect(gone.status).toBe(404);
      await gone.text();
      await expectInsightsIndex(history(installs[0]!), 0);

      const user = await client.admin(
        `/installations?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      expect(user.status).toBe(200);
      expect(await user.json()).toEqual({
        deleted: { installations: 2, events: 2 },
        complete: true,
      });
      await expectInsightsIndex(userInstalls, []);
      for (const installId of installs) {
        await expectInsightsIndex(history(installId), 0);
      }
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
