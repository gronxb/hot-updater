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

    it("serves daily observed bundles through the authenticated admin API", async () => {
      const client = options.getClient();
      const channel = `share-${crypto.randomUUID()}`;
      const day = 86_400_000;
      const start = Math.floor(Date.now() / day) * day;
      const event = {
        appVersion: "1.0.0",
        channel,
        cohort: "default",
        fingerprintHash: null,
        fromBundleId: null,
        fromReleaseId: null,
        installId: `share-${crypto.randomUUID()}`,
        platform: "ios",
        toBundleId: "00000000-0000-0000-0000-000000000000",
        toReleaseId: null,
        type: "UNCHANGED",
        updateStrategy: null,
      };
      const reported = await client.client(
        "/events",
        jsonRequest("POST", event),
      );
      expect(reported.status).toBe(204);
      await reported.text();
      const path = `/distribution-history?platform=ios&channel=${channel}&start=${start}&end=${start + day}`;
      await expectInsightsIndex(async () => {
        const response = await client.admin(path);
        expect(response.status).toBe(200);
        return ((await response.json()) as { points: unknown[] }).points;
      }, [
        {
          startMs: start,
          bundles: [
            {
              appVersion: "1.0.0",
              releaseId: null,
              bundleKind: "builtin",
              installations: 1,
            },
          ],
        },
      ]);
      const invalid = await client.admin(
        `/distribution-history?platform=ios&channel=${channel}&start=${start}&end=${start + 40 * day}`,
      );
      expect(invalid.status).toBe(400);
      await invalid.text();
    });

    it.each([
      { type: "UNCHANGED", status: 200, body: '{"releases":[]}' },
      { type: "UNCHANGED", status: 304, body: "" },
      {
        type: "UPDATE_FAILED",
        status: 503,
        body: '{"error":"Database unavailable"}',
      },
      {
        type: "UPDATE_DOWNLOADED",
        status: 200,
        body: '{"artifactProtocolVersion":1}',
      },
      { type: "UPDATE_APPLIED", status: 200, body: "{}" },
      { type: "RECOVERED", status: 502, body: null },
    ])(
      "keeps HTTP $status diagnostics on an existing $type report",
      async ({ type, status, body }) => {
        const client = options.getClient();
        const installId = `install-${crypto.randomUUID()}`;
        const channel = `http-${crypto.randomUUID()}`;
        const bundleId = "00000000-0000-7000-8000-000000000001";
        const httpResponse = {
          resource: "catalog",
          path: "/release-catalogs/app-version/ios/production/1.0.0",
          status,
          body,
          bodyTruncated: false,
          receivedAtMs: Date.now() - 1000,
        };
        const event = {
          eventId: "01929f4e-2b7c-7a51-9d3e-5c1f0a6b8e21",
          type,
          installId,
          platform: "ios",
          appVersion: "1.0.0",
          channel,
          cohort: "1",
          fingerprintHash: null,
          sdkVersion: "1.0.0",
          fromBundleId: type === "UNCHANGED" ? null : bundleId,
          toBundleId: bundleId,
          fromReleaseId: null,
          toReleaseId: null,
          updateStrategy: type === "UNCHANGED" ? null : "appVersion",
          metadata: {
            httpResponse,
            ...(type === "UPDATE_FAILED"
              ? {
                  failure: {
                    stage: "check",
                    reason: "http",
                    httpStatus: status,
                  },
                }
              : {}),
          },
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await client.client(
            "/events",
            jsonRequest("POST", event),
          );
          expect(response.status).toBe(204);
          await response.text();
        }
        const installation = await client.admin(
          `/installations/${encodeURIComponent(installId)}`,
        );
        if (type === "UPDATE_FAILED") {
          // A failed check does not replace the installation's running state.
          expect(installation.status).toBe(404);
        } else {
          expect(await installation.json()).toMatchObject({
            latestStatus: type,
            httpResponse,
          });
        }
        const history = await client.admin(
          `/installations/${encodeURIComponent(installId)}/events`,
        );
        const data = ((await history.json()) as { data: unknown[] }).data;
        expect(data).toHaveLength(type === "UNCHANGED" ? 0 : 1);
        if (type !== "UNCHANGED")
          expect(data[0]).toMatchObject({ type, httpResponse });
      },
    );

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

    it("refuses a malformed event", async () => {
      const response = await options
        .getClient()
        .client("/events", jsonRequest("POST", { type: "UNCHANGED" }));

      expect(response.status).toBe(400);
      await response.text();
    });
  });
};
