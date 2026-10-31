import type {
  BundleRow,
  ChannelRow,
  NativeBuildRow,
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
 * suites leave out: channels, deploy refusals, promotion, preflights, a
 * bundle's patch children, and the native build registry. Each test deletes
 * what it wrote, except a native build, which the registry keeps: its IDs
 * and channel are the test's own.
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

    it("registers native builds, finds the newest of a scope, and keeps their built-in bundles", async () => {
      const channel = `native-${namespace}`;
      const registration = (
        suffix: string,
        id = bundleRow(`8${suffix}`).id,
        buildKey: string | null = null,
      ) => {
        const builtIn = bundleRow(suffix);
        return admin(
          "/native-builds",
          jsonRequest("POST", {
            id,
            platform: "ios",
            channel,
            fingerprintHash: "native-fingerprint",
            appVersion: null,
            minBundleId: builtIn.id,
            gitCommitHash: null,
            buildKey,
            buildNumber: suffix,
            artifact: {
              kind: "ipa",
              storageUri: `storage://native-builds/ios/${suffix}/App.ipa`,
              byteSize: 1_000,
            },
            embeddedBundle: {
              manifestStorageUri: builtIn.manifest_storage_uri,
              manifestFileHash: builtIn.manifest_file_hash,
              assetBaseStorageUri: builtIn.asset_base_storage_uri,
            },
          }),
        );
      };
      const register = async (suffix: string, buildKey?: string) => {
        const response = await registration(
          suffix,
          bundleRow(`8${suffix}`).id,
          buildKey,
        );
        expect(response.status).toBe(201);
        return ((await response.json()) as { data: NativeBuildRow }).data;
      };
      const scope = (query: string) =>
        `/native-builds/latest?platform=ios&channel=${encodeURIComponent(channel)}&${query}`;
      const before = (await adminJson("/bundles?limit=1&total=true")) as {
        total: number;
      };

      const keyed = `nbk1:${"a".repeat(64)}`;
      const keyedBuild = await register("60", keyed);
      const newest = await register("61");
      // Another build of the same built-in bundle.
      const again = await registration("61", bundleRow("862").id);
      const refusedDelete = await admin(
        "/bundles/delete",
        jsonRequest("POST", { ids: [bundleRow("61").id] }),
      );

      expect(
        (await adminJson(scope("fingerprintHash=native-fingerprint"))).data,
      ).toEqual(newest);
      expect((await adminJson(scope("appVersion=1.0.0"))).data).toBeNull();
      // A build key finds the newest build of the scope registered with it,
      // and a build registered without one matches none.
      expect(keyedBuild.build_key).toBe(keyed);
      expect(newest.build_key).toBeNull();
      // The build number the registration sends is stored with the build.
      expect(newest.build_number).toBe("61");
      expect(
        (
          await adminJson(
            scope(`fingerprintHash=native-fingerprint&buildKey=${keyed}`),
          )
        ).data,
      ).toEqual(keyedBuild);
      expect(
        (
          await adminJson(
            scope(
              `fingerprintHash=native-fingerprint&buildKey=nbk1:${"b".repeat(64)}`,
            ),
          )
        ).data,
      ).toBeNull();
      const badKey = await admin(
        scope("fingerprintHash=native-fingerprint&buildKey=not-a-key"),
      );
      expect(badKey.status).toBe(400);
      await badKey.text();
      expect((await adminJson(`/native-builds/${newest.id}`)).data).toEqual(
        newest,
      );
      expect(
        (await adminJson(`/native-builds/${bundleRow("863").id}`)).data,
      ).toBeNull();
      // A channel's builds are this test's own registrations, newest first;
      // another channel's list holds none of them.
      const channelRow = (
        (await adminJson(`/channels?name=${encodeURIComponent(channel)}`)) as {
          data: ChannelRow;
        }
      ).data;
      const ofChannel = (channelId: string, query = "") =>
        adminJson(
          `/native-builds?channelId=${encodeURIComponent(channelId)}&order=desc&${query}`,
        ) as Promise<{ data: NativeBuildRow[]; next?: string }>;
      const firstPage = await ofChannel(channelRow.id, "limit=1");
      expect(firstPage).toEqual({ data: [newest], next: newest.id });
      expect(
        await ofChannel(channelRow.id, `limit=1&cursor=${newest.id}`),
      ).toEqual({ data: [keyedBuild], next: keyedBuild.id });
      expect((await ofChannel(channelRow.id, "limit=10")).data).toEqual([
        newest,
        keyedBuild,
      ]);
      const other = await api.ensureChannel(`native-other-${namespace}`);
      expect((await ofChannel(other.id, "limit=10")).data).toEqual([]);
      await adminJson(`/channels/${other.id}`, jsonRequest("DELETE"));
      expect((await ofChannel(other.id, "limit=10")).data).toEqual([]);
      // A store submission is recorded on the row, and read back with it.
      const submitted = (await adminJson(
        `/native-builds/${newest.id}/submission`,
        jsonRequest("POST", {
          destination: "testflight",
          version: "1.0.0 (7)",
        }),
      )) as { data: NativeBuildRow };
      expect(submitted.data).toMatchObject({
        id: newest.id,
        submitted_to: "testflight",
        submitted_version: "1.0.0 (7)",
      });
      expect((await adminJson(`/native-builds/${newest.id}`)).data).toEqual(
        submitted.data,
      );
      expect(
        (
          await adminJson(
            `/native-builds/${bundleRow("863").id}/submission`,
            jsonRequest("POST", {
              destination: "testflight",
              version: "1.0.0 (7)",
            }),
          )
        ).data,
      ).toBeNull();
      // An iOS build goes to TestFlight, not Google Play.
      const wrongStore = await admin(
        `/native-builds/${newest.id}/submission`,
        jsonRequest("POST", {
          destination: "play-internal",
          version: "1.0.0 (7)",
        }),
      );
      expect(wrongStore.status).toBe(400);
      await wrongStore.text();
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "NATIVE_BUILD_EXISTS" });
      expect(refusedDelete.status).toBe(409);
      await refusedDelete.text();
      expect((await adminJson(`/bundles/${bundleRow("61").id}`)).data).toEqual({
        bundle: { ...bundleRow("61"), metadata: {} },
        patches: [],
        childCount: 0,
      });
      const after = (await adminJson("/bundles?limit=1&total=true")) as {
        total: number;
      };
      expect(after.total).toBe(before.total);
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
