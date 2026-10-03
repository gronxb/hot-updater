import { describe, expect, it } from "vitest";

import type { HttpTestClient } from "../httpTestClient";
import { expectInsightsIndex } from "./expectInsightsIndex";

const jsonRequest = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
        sdkVersion: "2.0.0",
      };

      const reported = await client.client(
        "/events",
        jsonRequest("POST", event),
      );
      expect(reported.status).toBe(204);
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

    it("records an update failure in installation history and the failures read", async () => {
      const client = options.getClient();
      const installId = `install-${crypto.randomUUID()}`;
      const channel = `insights-${crypto.randomUUID()}`;
      const releaseId = "00000000-0000-7000-8000-0000000000b2";
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
          toReleaseId: releaseId,
          type: "UPDATE_FAILED",
          updateStrategy: "appVersion",
          metadata: {
            failure: { stage: "download", reason: "http", httpStatus: 403 },
          },
        }),
      );
      expect(reported.status).toBe(204);
      await reported.text();

      await expectInsightsIndex(async () => {
        const page = await client.admin(
          `/installations/${encodeURIComponent(installId)}/events?limit=10`,
        );
        return (
          (await page.json()) as {
            readonly data: readonly { type: string; failure?: unknown }[];
          }
        ).data.map(({ type, failure }) => ({ type, failure }));
      }, [
        {
          type: "UPDATE_FAILED",
          failure: { stage: "download", reason: "http", httpStatus: 403 },
        },
      ]);
      const now = Date.now();
      await expectInsightsIndex(async () => {
        const failures = await client.admin(
          `/failures?platform=ios&channel=${encodeURIComponent(channel)}&releaseId=${releaseId}&start=${now - 86_400_000}&end=${now + 3_600_000}`,
        );
        const body = (await failures.json()) as {
          readonly failedUpdates: number;
          readonly failedInstallations: number;
        };
        return [body.failedUpdates, body.failedInstallations];
      }, [1, 1]);
    });

    it("stores successful, cached, and failed HTTP responses without changing installation state or failures", async () => {
      const client = options.getClient();
      const installId = `install-${crypto.randomUUID()}`;
      const channel = `responses-${crypto.randomUUID()}`;
      const bundleId = "00000000-0000-7000-8000-000000000001";
      const base = {
        appVersion: "1.0.0",
        channel,
        cohort: "default",
        fingerprintHash: null,
        fromReleaseId: null,
        installId,
        platform: "ios",
        toBundleId: bundleId,
        toReleaseId: null,
        updateStrategy: null,
        sdkVersion: "test-sdk",
      };
      const launch = await client.client(
        "/events",
        jsonRequest("POST", { ...base, type: "UNCHANGED", fromBundleId: null }),
      );
      expect(launch.status).toBe(204);
      await launch.text();
      for (const status of [200, 304, 503]) {
        const report = {
          ...base,
          eventId: `00000000-0000-7000-8000-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
          type: "HTTP_RESPONSE",
          fromBundleId: bundleId,
          metadata: {
            httpResponse: {
              resource: "catalog",
              path: "/release-catalogs/app-version/ios/production/1.0.0",
              status,
              body: status === 304 ? "" : '{"message":"server reply"}',
              bodyTruncated: false,
            },
          },
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await client.client(
            "/events",
            jsonRequest("POST", report),
          );
          expect(response.status).toBe(204);
          await response.text();
        }
      }
      await expectInsightsIndex(async () => {
        const page = await client.admin(
          `/installations/${encodeURIComponent(installId)}/events?limit=10`,
        );
        expect(page.status).toBe(200);
        const { data } = (await page.json()) as {
          data: {
            type: string;
            httpResponse: { status: number; body: string };
          }[];
        };
        expect(data.every(({ type }) => type === "HTTP_RESPONSE")).toBe(true);
        return data
          .map(({ httpResponse }) => ({
            status: httpResponse.status,
            body: httpResponse.body,
          }))
          .sort((a, b) => a.status - b.status);
      }, [
        { status: 200, body: '{"message":"server reply"}' },
        { status: 304, body: "" },
        { status: 503, body: '{"message":"server reply"}' },
      ]);
      const installation = await client.admin(
        `/installations/${encodeURIComponent(installId)}`,
      );
      expect(await installation.json()).toMatchObject({
        latestStatus: "UNCHANGED",
        lastKnownBundleId: bundleId,
      });
      const now = Date.now();
      const failures = await client.admin(
        `/failures?platform=ios&channel=${encodeURIComponent(channel)}&start=${now - 86_400_000}&end=${now + 3_600_000}`,
      );
      expect(failures.status).toBe(200);
      expect(await failures.json()).toMatchObject({
        failedUpdates: 0,
        failedInstallations: 0,
      });
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
