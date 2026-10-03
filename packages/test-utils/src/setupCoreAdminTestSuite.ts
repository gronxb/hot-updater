import type {
  BundleRow,
  ChannelRow,
  ReleaseCatalogRow,
  ReleaseRow,
} from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAdminApiTestClient,
  jsonRequest,
  toDeployBundle,
} from "./adminApiTestClient";
import { createBundleRowFixture } from "./databaseTestFixtures";
import type { HttpTestClient } from "./httpTestClient";

/**
 * Core's operations through admin API protocol 2 that the bundle and catalog
 * suites leave out: channels, deploy refusals, promotion, preflights, and a
 * bundle's patch children. Each test deletes what it wrote.
 */
export const setupCoreAdminTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
}): void => {
  describe("Core admin API", () => {
    const api = createAdminApiTestClient(options.getClient);
    const { admin, adminJson } = api;
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
    const policy = (channel: string, enabled = true) => ({
      channel: `${channel}-${namespace}`,
      enabled,
      fingerprintHash: null,
      message: null,
      shouldForceUpdate: false,
      targetAppVersion: "1.0.x",
    });

    it("keeps one channel per name and deletes only an unused one", async () => {
      const name = `preview-${namespace}`;
      const [first, second] = await Promise.all([
        api.ensureChannel(name),
        api.ensureChannel(name),
      ]);
      expect(second).toEqual(first);
      expect(
        (await adminJson(`/channels?name=${encodeURIComponent(name)}`)).data,
      ).toEqual(first);
      expect(
        ((await adminJson("/channels")).data as ChannelRow[]).filter(
          (channel) => channel.name === name,
        ),
      ).toEqual([first]);

      const used = await api.deploy({
        bundle: toDeployBundle(bundleRow("10")),
        release: policy("used"),
      });
      const usedChannel = (
        (await adminJson(`/channels?name=used-${namespace}`)) as {
          data: ChannelRow;
        }
      ).data;
      const refused = await admin(
        `/channels/${usedChannel.id}`,
        jsonRequest("DELETE"),
      );
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        data: { deleted: false, reason: "not_empty" },
      });
      expect(used.channel_id).toBe(usedChannel.id);

      const deleted = await admin(
        `/channels/${first.id}`,
        jsonRequest("DELETE"),
      );
      expect(deleted.status).toBe(204);
      await deleted.text();
      const missing = await admin(
        `/channels/${first.id}`,
        jsonRequest("DELETE"),
      );
      expect(missing.status).toBe(404);
      await missing.text();
    });

    it("keeps a release's channel when a delete races the deploy into it", async () => {
      const channel = await api.ensureChannel(`race-${namespace}`);

      const [deleted, release] = await Promise.all([
        admin(`/channels/${channel.id}`, jsonRequest("DELETE")),
        api.deploy({
          bundle: toDeployBundle(bundleRow("15")),
          release: policy("race"),
        }),
      ]);
      await deleted.text();

      const channels = (await adminJson("/channels")).data as ChannelRow[];
      expect(channels.map(({ id }) => id)).toContain(release.channel_id);
    });

    it("refuses a malformed deployment and a stored bundle it does not hold", async () => {
      const malformed = await admin(
        "/releases",
        jsonRequest("POST", {
          deployments: [
            {
              bundle: { ...toDeployBundle(bundleRow("20")), platform: "web" },
              release: policy("production"),
            },
          ],
        }),
      );
      const missing = await admin(
        "/releases",
        jsonRequest("POST", {
          deployments: [
            { bundleId: bundleRow("21").id, release: policy("production") },
          ],
        }),
      );

      expect(malformed.status).toBe(400);
      await malformed.text();
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "BUNDLE_NOT_FOUND" });
    });

    it("copies a release into another channel, and moves one", async () => {
      const source = await api.deploy({
        bundle: toDeployBundle(bundleRow("30")),
        release: policy("production"),
      });

      type Promoted = {
        data: {
          source: { release: ReleaseRow | null } | null;
          target: { release: ReleaseRow | null };
        };
      };
      const copied = (await adminJson(
        `/releases/${source.id}/promote`,
        jsonRequest("POST", { targetChannel: `beta-${namespace}` }),
      )) as Promoted;
      const moved = (await adminJson(
        `/releases/${source.id}/promote`,
        jsonRequest("POST", {
          targetChannel: `staging-${namespace}`,
          action: "move",
        }),
      )) as Promoted;
      for (const { data } of [copied, moved])
        api.track(data.target.release!.id);

      expect(copied.data.source).toBeNull();
      expect(copied.data.target.release).toMatchObject({
        bundle_id: source.bundle_id,
        enabled: true,
      });
      expect(moved.data.target.release?.bundle_id).toBe(source.bundle_id);
      expect(moved.data.source?.release?.enabled).toBe(false);
      expect(
        ((await adminJson(`/releases/${source.id}`)) as { data: ReleaseRow })
          .data.enabled,
      ).toBe(false);
    });

    it("previews a policy change and a catalog rebuild without writing", async () => {
      const release = await api.deploy({
        bundle: toDeployBundle(bundleRow("40")),
        release: policy("production"),
      });
      const catalogPath = `/release-catalogs/${encodeURIComponent(release.scope_key)}`;
      const before = (await adminJson(catalogPath)) as {
        data: ReleaseCatalogRow;
      };

      const preflight = await adminJson(
        `/releases/${release.id}/preflight`,
        jsonRequest("POST", { expectedRevision: 1, patch: { enabled: false } }),
      );
      const rebuild = await adminJson(
        `${catalogPath}/preflight`,
        jsonRequest("POST"),
      );

      expect(preflight.data).toBeDefined();
      expect(rebuild.data).toBeDefined();
      expect(await adminJson(catalogPath)).toEqual(before);
      expect(
        ((await adminJson(`/releases/${release.id}`)) as { data: ReleaseRow })
          .data,
      ).toEqual(release);
    });

    it("lists the patches that start from a bundle", async () => {
      const base = bundleRow("50");
      const target = bundleRow("51");
      await api.deploy({
        bundle: toDeployBundle(base),
        release: policy("production", false),
      });
      await api.deploy({
        bundle: {
          ...toDeployBundle(target),
          patches: [
            {
              baseBundleId: base.id,
              baseFileHash: "base-hash",
              byteSize: 10,
              patchFileHash: "patch-hash",
              patchStorageUri: "storage://patches/51.patch",
            },
          ],
        },
        release: policy("production", false),
      });

      const children = await adminJson(`/bundles/${base.id}/children`);
      const detail = await adminJson(`/bundles/${base.id}`);

      expect(children.data).toEqual([
        expect.objectContaining({
          bundle_id: target.id,
          base_bundle_id: base.id,
        }),
      ]);
      expect(detail.data.childCount).toBe(1);
    });
  });
};
