import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createReleaseCatalogScopeKey,
  encodeChannelKey,
} from "@hot-updater/protocol";
import { createHotUpdater } from "@hot-updater/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAdminApiTestClient,
  jsonRequest,
  toDeployBundle,
} from "./adminApiTestClient";
import { createBundleRowFixture } from "./databaseTestFixtures";
import type { HttpTestClient } from "./httpTestClient";
import { createReleaseCatalogTestStorage } from "./releaseCatalogHttpFixtures";
import { setReleaseCatalogPartitioning } from "./releaseCatalogPartitionFixture";

const PATH = "/release-catalog-partitioning";

/**
 * Turning release catalog partitioning on through a provider's server, with
 * the credentials that server runs with: the probe of
 * `release_catalog_partitions` on the provider's own store, both doors (the
 * admin route, and the client route with a request token stored through the
 * database), and a deploy the server then converts. Each test turns the
 * switch off again afterwards, as nothing in the product does, since the
 * suite's reset keeps settings rows.
 */
export const setupPartitioningEnableTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
  readonly getDatabase: () => EngineDatabase;
}): void => {
  describe("Release catalog partitioning", () => {
    const api = createAdminApiTestClient(options.getClient);
    afterEach(async () => {
      await api.cleanup();
      await setReleaseCatalogPartitioning(options.getDatabase().adapter, "off");
    });

    const status = async () =>
      (await api.adminJson(PATH)) as {
        data: { switch: string; table: string };
      };

    it("turns on through the admin route after the server's own probe, once, and the next deploy converts the scope", async () => {
      expect(await status()).toEqual({
        data: { switch: "off", table: "present" },
      });
      expect(await api.adminJson(PATH, jsonRequest("POST"))).toEqual({
        data: { partitioning: "on", changed: true },
      });
      expect(await api.adminJson(PATH, jsonRequest("POST"))).toEqual({
        data: { partitioning: "on", changed: false },
      });
      expect(await status()).toEqual({
        data: { switch: "on", table: "present" },
      });

      const channel = `partitioned-${crypto.randomUUID()}`;
      const bundle = createBundleRowFixture("71");
      await api.deploy({
        bundle: toDeployBundle({
          ...bundle,
          id: `${crypto.randomUUID().slice(0, 8)}-0000-7000-8000-000000000071`,
        }),
        release: {
          channel,
          enabled: true,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "1.0.x",
        },
      });
      const scopeKey = createReleaseCatalogScopeKey({
        channelKey: encodeChannelKey(channel),
        platform: bundle.platform,
        strategy: "APP_VERSION",
      });
      const preflight = (await api.adminJson(
        `/release-catalogs/${encodeURIComponent(scopeKey)}/preflight`,
        jsonRequest("POST"),
      )) as { data: { layout?: string; changed: boolean } };
      expect(preflight.data).toMatchObject({
        changed: false,
        layout: "partitioned",
      });
      const check = await options
        .getClient()
        .client(
          `/release-catalogs/app-version/${bundle.platform}/${encodeChannelKey(channel)}/1.0.0`,
        );
      expect(check.status).toBe(200);
      await check.text();
    });

    it("turns on through the client route with a request token stored through the database, once", async () => {
      const issue = () =>
        createHotUpdater({
          clientAccess: "public",
          database: options.getDatabase(),
          storage: createReleaseCatalogTestStorage(),
        }).core.issueReleaseCatalogPartitioningToken();
      const post = (token: string) =>
        options.getClient().client(PATH, jsonRequest("POST", { token }));

      const wrong = await post("wrong");
      expect(wrong.status).toBe(403);
      await wrong.text();
      const token = await issue();
      const enabled = await post(token);
      expect(enabled.headers.get("cache-control")).toBe("private, no-store");
      expect(await enabled.json()).toEqual({
        data: { partitioning: "on", changed: true },
      });
      const replayed = await post(token);
      expect(replayed.status).toBe(403);
      await replayed.text();
      expect(await status()).toEqual({
        data: { switch: "on", table: "present" },
      });
    });
  });
};
