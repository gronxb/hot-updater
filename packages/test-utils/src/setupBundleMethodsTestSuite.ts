import type { BundleRow } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdminApiTestClient,
  jsonRequest,
  toDeployBundle,
} from "./adminApiTestClient";
import { createBundleRowFixture } from "./databaseTestFixtures";
import type { HttpTestClient } from "./httpTestClient";

type BundleDetail = {
  readonly bundle: BundleRow;
  readonly patches: readonly unknown[];
  readonly childCount: number;
};

type BundlePage = {
  readonly data: BundleDetail[];
  readonly next?: string;
  readonly total?: number;
};

/**
 * Bundles through admin API protocol 2: deployed with a release, read by
 * id, paged by key, changed, and deleted. Each test deletes what it wrote.
 */
export const setupBundleMethodsTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Bundle admin API", () => {
    const api = createAdminApiTestClient(options.getClient);
    const { admin, adminJson } = api;
    let namespace: string;
    beforeEach(() => {
      namespace = crypto.randomUUID();
    });
    afterEach(async () => {
      await api.cleanup();
    });

    /** A bundle id unique to the test, ordered by suffix. */
    const bundleRow = (
      suffix: string,
      platform: "ios" | "android" = "ios",
    ): BundleRow => ({
      ...createBundleRowFixture(suffix),
      id: `${namespace.slice(0, 8)}-0000-7000-8000-${suffix.padStart(12, "0")}`,
      platform,
    });
    const deploy = (row: BundleRow) =>
      api.deploy({
        bundle: toDeployBundle(row),
        release: {
          channel: `bundles-${namespace}`,
          enabled: false,
          fingerprintHash: null,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: "*",
        },
      });
    const mine = (page: BundlePage) =>
      page.data
        .map(({ bundle }) => bundle.id)
        .filter((id) => id.startsWith(namespace.slice(0, 8)));

    it("stores a deployed bundle's fields", async () => {
      const input = bundleRow("10");
      await deploy(input);

      const { data } = (await adminJson(`/bundles/${input.id}`)) as {
        data: BundleDetail;
      };

      expect(data).toEqual({
        bundle: input,
        patches: [],
        childCount: 0,
      });
    });

    it("answers 404 for a missing bundle", async () => {
      const response = await admin(`/bundles/${bundleRow("99").id}`);

      expect(response.status).toBe(404);
      await response.text();
    });

    it("pages bundles by key and filters by platform", async () => {
      const first = bundleRow("40");
      const second = bundleRow("41");
      const android = bundleRow("42", "android");
      for (const row of [first, second, android]) await deploy(row);
      const prefix = `${namespace.slice(0, 8)}-0000-7000-8000-000000000039`;

      const page1 = (await adminJson(
        `/bundles?order=asc&limit=1&cursor=${prefix}&platform=ios`,
      )) as BundlePage;
      const page2 = (await adminJson(
        `/bundles?order=asc&limit=1&cursor=${page1.next}&platform=ios`,
      )) as BundlePage;
      const androidPage = (await adminJson(
        `/bundles?order=asc&limit=100&cursor=${prefix}&platform=android`,
      )) as BundlePage;

      expect(mine(page1)).toEqual([first.id]);
      expect(page1.next).toBe(first.id);
      expect(mine(page2)).toEqual([second.id]);
      expect(mine(androidPage)).toEqual([android.id]);
    });

    it("counts bundles with a page when asked", async () => {
      const before = (await adminJson("/bundles?limit=1&total=true")) as {
        total: number;
      };
      await deploy(bundleRow("50"));

      const after = (await adminJson("/bundles?limit=1&total=true")) as {
        total: number;
      };

      expect(after.total).toBe(before.total + 1);
    });

    it("changes a bundle's fields", async () => {
      const input = bundleRow("60");
      await deploy(input);

      const response = await admin(
        `/bundles/${input.id}`,
        jsonRequest("PATCH", { gitCommitHash: "abc123" }),
      );

      expect(response.status).toBe(204);
      expect(
        ((await adminJson(`/bundles/${input.id}`)) as { data: BundleDetail })
          .data.bundle.git_commit_hash,
      ).toBe("abc123");
    });

    it("refuses to delete a bundle a release uses, then deletes it", async () => {
      const input = bundleRow("70");
      const release = await deploy(input);

      const refused = await admin(
        "/bundles/delete",
        jsonRequest("POST", { ids: [input.id] }),
      );
      expect(refused.status).toBe(409);
      await refused.text();

      await api.removeRelease(release.id);
      api.forget(release.id);
      await adminJson(
        "/bundles/delete",
        jsonRequest("POST", { ids: [input.id] }),
      );

      expect((await admin(`/bundles/${input.id}`)).status).toBe(404);
    });
  });
};
