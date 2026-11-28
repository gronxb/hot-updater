import type {
  BundleRow,
  PromoteReleaseResult,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdminApiTestClient,
  jsonRequest,
  toDeployBundle,
} from "./adminApiTestClient";
import { createBundleRowFixture } from "./databaseTestFixtures";
import type { HttpTestClient } from "./httpTestClient";

/**
 * Release labels through a provider's admin and client HTTP APIs: deploys
 * take each channel and platform's next label, concurrent ones never the
 * same, a promotion takes the target's next, a delete leaves a gap, the
 * list, detail and label lookup answer it, and the scope's catalog serves
 * it. The backfill and the label index's uniqueness, which need rows an
 * earlier server wrote, are `setupReleaseLabelEngineTestSuite`'s.
 */
export const setupReleaseLabelTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Release labels", () => {
    const api = createAdminApiTestClient(options.getClient);
    const { adminJson } = api;
    let namespace: string;
    beforeEach(() => {
      namespace = crypto.randomUUID();
    });
    afterEach(async () => {
      await api.cleanup();
    });

    const bundleRow = (suffix: string): BundleRow => ({
      ...createBundleRowFixture(suffix),
      id: `${namespace.slice(0, 8)}-0000-7000-8000-${suffix.padStart(12, "0")}`,
    });
    const channel = (name = "labels") => `${name}-${namespace}`;
    const deploy = (
      suffix: string,
      {
        fingerprintHash = null,
        platform = "ios",
        channelName = channel(),
      }: {
        readonly fingerprintHash?: string | null;
        readonly platform?: "ios" | "android";
        readonly channelName?: string;
      } = {},
    ) =>
      api.deploy({
        bundle: { ...toDeployBundle(bundleRow(suffix)), platform },
        release: {
          channel: channelName,
          enabled: true,
          fingerprintHash,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: fingerprintHash === null ? "1.0.x" : null,
        },
      });
    const byLabel = async (
      label: number,
      { platform = "ios", channelName = channel() } = {},
    ) =>
      (
        (await adminJson(
          `/release-labels?channel=${encodeURIComponent(channelName)}&platform=${platform}&label=${label}`,
        )) as { data: ReleaseRow | null }
      ).data;
    const detail = async (id: string) =>
      (
        (await adminJson(`/releases/${encodeURIComponent(id)}`)) as {
          data: ReleaseRow;
        }
      ).data;

    it("labels each channel and platform's deploys in order, and answers the label in the list, the detail and the lookup", async () => {
      const first = await deploy("1");
      const second = await deploy("2");
      const android = await deploy("3", { platform: "android" });

      expect([first.label, second.label, android.label]).toEqual([1, 2, 1]);
      const { data: listed } = (await adminJson(
        `/releases?channelId=${encodeURIComponent(first.channel_id)}&platform=ios&limit=10`,
      )) as { data: ReleaseRow[] };
      expect(
        Object.fromEntries(listed.map(({ id, label }) => [id, label])),
      ).toEqual({ [first.id]: 1, [second.id]: 2 });
      await expect(detail(second.id)).resolves.toMatchObject({ label: 2 });
      await expect(byLabel(2)).resolves.toMatchObject({
        id: second.id,
        label: 2,
      });
      await expect(byLabel(1, { platform: "android" })).resolves.toMatchObject({
        id: android.id,
      });
      await expect(byLabel(3)).resolves.toBeNull();
    });

    it("never gives concurrent deploys one label", async () => {
      await deploy("10");

      const releases = await Promise.all(
        ["11", "12", "13", "14"].map((suffix) =>
          deploy(suffix, { fingerprintHash: `fingerprint-${suffix}` }),
        ),
      );

      expect(releases.map(({ label }) => label).sort()).toEqual([2, 3, 4, 5]);
    });

    it("keeps a label through disable and enable, leaves a gap on delete, and gives a promotion the target's next label", async () => {
      const first = await deploy("21");
      const second = await deploy("22");
      await adminJson(
        `/releases/${encodeURIComponent(first.id)}`,
        jsonRequest("PATCH", { patch: { enabled: false } }),
      );
      await adminJson(
        `/releases/${encodeURIComponent(first.id)}`,
        jsonRequest("PATCH", { patch: { enabled: true } }),
      );
      await expect(detail(first.id)).resolves.toMatchObject({ label: 1 });
      await api.removeRelease(second.id);
      api.forget(second.id);
      await expect(deploy("23")).resolves.toMatchObject({ label: 3 });
      await deploy("24", { channelName: channel("target") });

      const { data: promoted } = (await adminJson(
        `/releases/${encodeURIComponent(first.id)}/promote`,
        jsonRequest("POST", {
          targetChannel: channel("target"),
          action: "copy",
        }),
      )) as { data: PromoteReleaseResult };
      api.track(promoted.target.release!.id);

      expect(promoted.target.release).toMatchObject({ label: 2 });
      await expect(detail(first.id)).resolves.toMatchObject({ label: 1 });
    });

    it("serves each release's label in its scope's catalog", async () => {
      const first = await deploy("31");
      const second = await deploy("32");

      const response = await options
        .getClient()
        .client(
          `/release-catalogs/app-version/ios/${encodeChannelKey(channel())}/1.0.0`,
        );
      expect(response.status).toBe(200);
      const catalog = (await response.json()) as {
        releases: { releaseId: string; label?: number }[];
      };
      expect(
        Object.fromEntries(
          catalog.releases.map(({ releaseId, label }) => [releaseId, label]),
        ),
      ).toEqual({ [first.id]: 1, [second.id]: 2 });
    });

    it("has nothing to fill on a database whose releases all have labels", async () => {
      await deploy("41");

      await expect(
        adminJson(
          "/release-labels/fill",
          jsonRequest("POST", { dryRun: true }),
        ),
      ).resolves.toEqual({ data: { releases: 0, catalogs: 0 } });
    });
  });
};
