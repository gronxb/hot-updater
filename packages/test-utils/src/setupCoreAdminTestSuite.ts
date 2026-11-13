import type {
  BundleRow,
  ChannelRow,
  IosDeviceRow,
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
 * bundle's patch children, the native build registry, and the iOS device
 * registry. Each test deletes what it wrote, except a native build, which the
 * registry keeps: its IDs and channel are the test's own.
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
      const androidBuiltIn = bundleRow("64");
      const androidResponse = await admin(
        "/native-builds",
        jsonRequest("POST", {
          id: bundleRow("864").id,
          platform: "android",
          channel,
          fingerprintHash: "android-fingerprint",
          appVersion: null,
          minBundleId: androidBuiltIn.id,
          gitCommitHash: null,
          buildKey: null,
          buildNumber: "64",
          artifact: {
            kind: "aab",
            storageUri: "storage://native-builds/android/64/app.aab",
            byteSize: 1000,
          },
          embeddedBundle: {
            manifestStorageUri: androidBuiltIn.manifest_storage_uri,
            manifestFileHash: androidBuiltIn.manifest_file_hash,
            assetBaseStorageUri: androidBuiltIn.asset_base_storage_uri,
          },
        }),
      );
      expect(androidResponse.status).toBe(201);
      await androidResponse.text();
      const production = await admin(
        `/native-builds/${bundleRow("864").id}/submission`,
        jsonRequest("POST", {
          destination: "play-production",
          version: "1.0.0 (64)",
        }),
      );
      expect(production.status).toBe(200);
      expect((await production.json()).data.submitted_to).toBe(
        "play-production",
      );
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

    it("marks one store build per native build scope, replacing and clearing it", async () => {
      const channel = `store-build-${namespace}`;
      const register = async (suffix: string, fingerprintHash: string) => {
        const builtIn = bundleRow(suffix);
        const response = await admin(
          "/native-builds",
          jsonRequest("POST", {
            id: bundleRow(`8${suffix}`).id,
            platform: "ios",
            channel,
            fingerprintHash,
            appVersion: null,
            minBundleId: builtIn.id,
            gitCommitHash: null,
            buildKey: null,
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
        expect(response.status).toBe(201);
        return ((await response.json()) as { data: NativeBuildRow }).data;
      };
      const mark = (id: string, storeBuild: boolean) =>
        admin(
          `/native-builds/${id}/store-build`,
          jsonRequest("POST", { storeBuild }),
        );
      const markRead = (fingerprintHash: string) =>
        `/native-builds/latest?platform=ios&channel=${encodeURIComponent(channel)}&fingerprintHash=${fingerprintHash}&storeBuild=true`;

      const older = await register("64", "store-fingerprint");
      const newer = await register("65", "store-fingerprint");
      const otherScope = await register("66", "store-fingerprint-b");
      expect(older.is_store_build).toBe(false);
      expect((await adminJson(markRead("store-fingerprint"))).data).toBeNull();

      const marked = await mark(older.id, true);
      expect(marked.status).toBe(200);
      expect(await marked.json()).toMatchObject({
        data: {
          nativeBuild: { id: older.id, is_store_build: true },
          previous: null,
        },
      });
      expect((await adminJson(markRead("store-fingerprint"))).data).toEqual({
        ...older,
        is_store_build: true,
      });
      // The newest build is still the newest, and a mark stays in its scope.
      expect(
        (
          await adminJson(
            `/native-builds/latest?platform=ios&channel=${encodeURIComponent(channel)}&fingerprintHash=store-fingerprint`,
          )
        ).data,
      ).toEqual(newer);
      expect(
        (await adminJson(markRead("store-fingerprint-b"))).data,
      ).toBeNull();

      // Moving the mark frees its value and takes it in one write, on every
      // store: the replaced build holds no mark after it.
      const replaced = await mark(newer.id, true);
      expect(await replaced.json()).toMatchObject({
        data: {
          nativeBuild: { id: newer.id, is_store_build: true },
          previous: { id: older.id, is_store_build: false },
        },
      });
      expect((await adminJson(`/native-builds/${older.id}`)).data).toEqual(
        older,
      );
      expect((await adminJson(markRead("store-fingerprint"))).data).toEqual({
        ...newer,
        is_store_build: true,
      });

      // Racing marks leave one, whichever store runs them, and every one of
      // them succeeds: a loser takes the value after the winner.
      const race = async (ids: readonly string[]) => {
        const responses = await Promise.all(ids.map((id) => mark(id, true)));
        expect(responses.map(({ status }) => status)).toEqual(
          ids.map(() => 200),
        );
        const results = (await Promise.all(
          responses.map((response) => response.json()),
        )) as { data: { nativeBuild: NativeBuildRow } }[];
        expect(
          results.map(({ data }) => data.nativeBuild.is_store_build),
        ).toEqual(ids.map(() => true));
        const holders = (
          await Promise.all(
            [older, newer].map(
              async ({ id }) =>
                (
                  (await adminJson(`/native-builds/${id}`)) as {
                    data: NativeBuildRow;
                  }
                ).data,
            ),
          )
        ).filter(({ is_store_build }) => is_store_build);
        expect(holders).toHaveLength(1);
        expect(ids).toContain(holders[0]!.id);
      };
      await race([older.id, newer.id, older.id]);

      // From a scope with no mark: the first marks meet at the index.
      await mark(older.id, false).then((response) => response.text());
      await mark(newer.id, false).then((response) => response.text());
      expect((await adminJson(markRead("store-fingerprint"))).data).toBeNull();
      await race([older.id, newer.id]);

      const cleared = await mark(newer.id, false);
      await cleared.text();
      await mark(older.id, false).then((response) => response.text());
      expect((await adminJson(markRead("store-fingerprint"))).data).toBeNull();

      // An unknown ID answers null, a body without storeBuild is refused.
      expect(
        await (await mark(bundleRow("869").id, true)).json(),
      ).toMatchObject({ data: null });
      const refused = await admin(
        `/native-builds/${older.id}/store-build`,
        jsonRequest("POST", {}),
      );
      expect(refused.status).toBe(400);
      await refused.text();

      // A deleted build takes its mark, and the next mark takes the value.
      await mark(otherScope.id, true).then((response) => response.text());
      await adminJson(`/native-builds/${otherScope.id}`, jsonRequest("DELETE"));
      expect(
        (await adminJson(markRead("store-fingerprint-b"))).data,
      ).toBeNull();
    });

    it("records a sandbox build on any channel, finds it through its sandbox scope, and refuses one its artifact doesn't describe", async () => {
      const sandboxChannel = `pr-${namespace}`;
      const channel = `plain-${namespace}`;
      const sandboxFields = {
        isSandbox: true,
        sandboxUrlScheme: "acme-preview",
        sandboxAppId: "com.example.app",
        exportMethod: "ad-hoc",
      };
      const post = (suffix: string, body: Record<string, unknown>) => {
        const builtIn = bundleRow(suffix);
        return admin(
          "/native-builds",
          jsonRequest("POST", {
            id: bundleRow(`8${suffix}`).id,
            platform: "ios",
            fingerprintHash: "sandbox-fingerprint",
            appVersion: null,
            minBundleId: builtIn.id,
            gitCommitHash: null,
            buildKey: null,
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
            ...body,
          }),
        );
      };
      const refusal = async (suffix: string, body: Record<string, unknown>) => {
        const response = await post(suffix, body);
        await response.text();
        return response.status;
      };

      // A sandbox build needs the URL scheme and app ID its scope is of.
      expect(await refusal("74", { channel, isSandbox: true })).toBe(400);
      expect(
        await refusal("74", {
          channel,
          ...sandboxFields,
          sandboxAppId: undefined,
        }),
      ).toBe(400);
      expect(
        await refusal("74", { channel, sandboxAppId: "com.example.app" }),
      ).toBe(400);
      expect(
        await refusal("74", { channel: sandboxChannel, isSandbox: null }),
      ).toBe(400);
      expect(
        await refusal("74", { channel: sandboxChannel, isSandbox: "yes" }),
      ).toBe(400);
      expect(
        await refusal("74", { channel, sandboxUrlScheme: "acme-preview" }),
      ).toBe(400);
      expect(
        await refusal("74", {
          channel: sandboxChannel,
          ...sandboxFields,
          sandboxUrlScheme: "Acme",
        }),
      ).toBe(400);
      expect(
        await refusal("74", {
          channel: sandboxChannel,
          ...sandboxFields,
          sandboxUrlScheme: 42,
        }),
      ).toBe(400);

      expect(await refusal("74", { channel, nativeAppVersion: 42 })).toBe(400);
      expect(await refusal("74", { channel, nativeAppVersion: " " })).toBe(400);

      const tagged = await post("72", {
        channel: sandboxChannel,
        ...sandboxFields,
        nativeAppVersion: "1.6.0",
      });
      expect(tagged.status).toBe(201);
      const sandboxBuild = ((await tagged.json()) as { data: NativeBuildRow })
        .data;
      // A normal build of the same fingerprint, on the sandbox build's channel.
      const plain = await post("73", {
        channel: sandboxChannel,
        isSandbox: false,
      });
      expect(plain.status).toBe(201);
      const plainBuild = ((await plain.json()) as { data: NativeBuildRow })
        .data;

      expect(sandboxBuild).toMatchObject({
        is_sandbox: true,
        is_store_build: false,
        sandbox_url_scheme: "acme-preview",
        native_app_version: "1.6.0",
      });
      expect(plainBuild).toMatchObject({
        is_sandbox: false,
        is_store_build: false,
        sandbox_url_scheme: null,
        export_method: null,
        native_app_version: null,
      });
      const sandboxLookup =
        "sandboxAppId=com.example.app&sandboxUrlScheme=acme-preview&artifactKind=ipa&distribution=direct";
      expect(
        (await adminJson(`/native-builds/${sandboxBuild.id}`)).data,
      ).toEqual(sandboxBuild);
      expect((await adminJson(`/native-builds/${plainBuild.id}`)).data).toEqual(
        plainBuild,
      );
      // Found through its sandbox scope, whichever channel the lookup names,
      // and never through the channel's normal scope.
      expect(
        (
          await adminJson(
            `/native-builds/latest?platform=ios&channel=other-${namespace}&fingerprintHash=sandbox-fingerprint&${sandboxLookup}`,
          )
        ).data,
      ).toEqual(sandboxBuild);
      expect(
        (
          await adminJson(
            `/native-builds/latest?platform=ios&channel=${encodeURIComponent(sandboxChannel)}&fingerprintHash=sandbox-fingerprint`,
          )
        ).data,
      ).toEqual(plainBuild);
      // A lookup that names part of a sandbox scope is a bad request.
      const partial = await admin(
        `/native-builds/latest?platform=ios&channel=${encodeURIComponent(sandboxChannel)}&fingerprintHash=sandbox-fingerprint&sandboxAppId=com.example.app`,
      );
      expect(partial.status).toBe(400);
      await partial.text();
      const invalid = await admin(
        `/native-builds/latest?platform=ios&channel=${encodeURIComponent(sandboxChannel)}&fingerprintHash=sandbox-fingerprint&${sandboxLookup.replace("artifactKind=ipa", "artifactKind=apk")}`,
      );
      expect(invalid.status).toBe(400);
      await invalid.text();
      // A sandbox build's built-in bundle is no patch base.
      expect(
        (
          await adminJson(
            `/native-builds/latest?platform=ios&channel=${encodeURIComponent(sandboxChannel)}&fingerprintHash=sandbox-fingerprint&${sandboxLookup}&builtInOlderThan=ffffffff-ffff-7fff-bfff-ffffffffffff`,
          )
        ).data,
      ).toBeNull();
      const patched = await admin(
        `/bundles/${plainBuild.min_bundle_id}`,
        jsonRequest("PATCH", {
          patches: [
            {
              baseBundleId: sandboxBuild.min_bundle_id,
              baseFileHash: "base-hash",
              byteSize: 42,
              patchFileHash: "patch-hash",
              patchStorageUri: "storage://patches/sandbox.patch",
            },
          ],
        }),
      );
      expect(patched.status).toBe(400);
      expect(await patched.text()).toContain(
        "A sandbox build's built-in bundle is no patch base.",
      );
      // Nor does a deploy write a new bundle with one.
      const deployed = await admin(
        "/releases",
        jsonRequest("POST", {
          deployments: [
            {
              bundle: {
                ...toDeployBundle(bundleRow("76")),
                patches: [
                  {
                    baseBundleId: sandboxBuild.min_bundle_id,
                    baseFileHash: "base-hash",
                    byteSize: 42,
                    patchFileHash: "patch-hash",
                    patchStorageUri: "storage://patches/sandbox-deploy.patch",
                  },
                ],
              },
              release: policy("sandbox-patch"),
            },
          ],
        }),
      );
      expect(deployed.status).toBe(400);
      expect(await deployed.text()).toContain(
        "A sandbox build's built-in bundle is no patch base.",
      );
      const notDeployed = await admin(`/bundles/${bundleRow("76").id}`);
      expect(notDeployed.status).toBe(404);
      await notDeployed.text();

      const marked = await admin(
        `/native-builds/${sandboxBuild.id}/store-build`,
        jsonRequest("POST", { storeBuild: true }),
      );
      expect(marked.status).toBe(400);
      await marked.text();
    });

    it("finds a scope's build of one kind, and a sandbox build's other install target", async () => {
      const channel = `kinds-${namespace}`;
      const register = async (
        suffix: string,
        kind: "ipa" | "app",
        body: Record<string, unknown> = {},
      ) => {
        const builtIn = bundleRow(suffix);
        const response = await admin(
          "/native-builds",
          jsonRequest("POST", {
            id: bundleRow(`8${suffix}`).id,
            platform: "ios",
            channel,
            fingerprintHash: "kind-fingerprint",
            appVersion: null,
            minBundleId: builtIn.id,
            gitCommitHash: null,
            buildKey: null,
            artifact: {
              kind,
              storageUri: `storage://native-builds/ios/${suffix}/App.${kind === "ipa" ? "ipa" : "app.zip"}`,
              byteSize: 1_000,
            },
            embeddedBundle: {
              manifestStorageUri: builtIn.manifest_storage_uri,
              manifestFileHash: builtIn.manifest_file_hash,
              assetBaseStorageUri: builtIn.asset_base_storage_uri,
            },
            ...body,
          }),
        );
        expect(response.status).toBe(201);
        return ((await response.json()) as { data: NativeBuildRow }).data;
      };
      const sandbox = (exportMethod: string | null) => ({
        isSandbox: true,
        sandboxUrlScheme: "acme-preview",
        sandboxAppId: "com.example.app",
        exportMethod,
      });

      const ipa = await register("81", "ipa");
      const app = await register("82", "app");
      const latest = `/native-builds/latest?platform=ios&channel=${encodeURIComponent(channel)}&fingerprintHash=kind-fingerprint`;
      expect((await adminJson(latest)).data).toEqual(app);
      expect((await adminJson(`${latest}&kind=ipa`)).data).toEqual(ipa);
      const refused = await admin(`${latest}&kind=apk`);
      expect(refused.status).toBe(400);
      await refused.text();

      const sandboxIpa = await register("83", "ipa", sandbox("ad-hoc"));
      const sandboxApp = await register("84", "app", sandbox(null));
      expect(
        (await adminJson(`/native-builds/${sandboxIpa.id}/sibling`)).data,
      ).toEqual(sandboxApp);
      expect(
        (await adminJson(`/native-builds/${sandboxApp.id}/sibling`)).data,
      ).toEqual(sandboxIpa);
      // A normal build pairs with nothing, and an unknown ID finds nothing.
      expect(
        (await adminJson(`/native-builds/${ipa.id}/sibling`)).data,
      ).toBeNull();
      expect(
        (await adminJson(`/native-builds/${bundleRow("899").id}/sibling`)).data,
      ).toBeNull();
    });

    it("requests, approves, renames, records, and removes iOS devices", async () => {
      // A UDID of the test's own: 40 hex digits from its namespace.
      const udid = namespace.replaceAll("-", "").padEnd(40, "0");
      const device = async (path: string, init?: Parameters<typeof admin>[1]) =>
        (await adminJson(path, init)).data as IosDeviceRow | null;
      const requested = (await adminJson(
        "/ios-devices",
        jsonRequest("POST", {
          udid: udid.toUpperCase(),
          name: "Kim's iPhone",
          requestedBy: "kim@team.dev",
        }),
      )) as { data: { device: IosDeviceRow; created: boolean } };
      expect(requested.data.created).toBe(true);
      const { id } = requested.data.device;
      expect(requested.data.device).toMatchObject({
        udid,
        status: "pending",
        requested_by: "kim@team.dev",
      });
      try {
        const again = (await adminJson(
          "/ios-devices",
          jsonRequest("POST", { udid, name: "Other", requestedBy: null }),
        )) as { data: { device: IosDeviceRow; created: boolean } };
        expect(again.data).toEqual({
          device: requested.data.device,
          created: false,
        });
        // Two first requests of another UDID at once: its unique index keeps
        // one row, and both answer with it.
        const raced = `${udid.slice(0, 39)}f`;
        const racing = (await Promise.all(
          ["Other", "Another"].map((name) =>
            adminJson(
              "/ios-devices",
              jsonRequest("POST", { udid: raced, name, requestedBy: null }),
            ),
          ),
        )) as { data: { device: IosDeviceRow; created: boolean } }[];
        expect(racing.map(({ data }) => data.created).sort()).toEqual([
          false,
          true,
        ]);
        expect(racing[0]!.data.device.id).toBe(racing[1]!.data.device.id);
        await adminJson(
          `/ios-devices/${racing[0]!.data.device.id}`,
          jsonRequest("DELETE"),
        );
        expect(await device(`/ios-devices/udid/${udid}`)).toEqual(
          requested.data.device,
        );
        const pending = (await adminJson(
          "/ios-devices?status=pending&limit=500",
        )) as { data: IosDeviceRow[] };
        expect(pending.data.map((row) => row.id)).toContain(id);

        const approval = await device(
          `/ios-devices/${id}/approval`,
          jsonRequest("POST", { approvedBy: "lead@team.dev" }),
        );
        expect(approval).toMatchObject({
          status: "approved",
          approved_by: "lead@team.dev",
        });
        expect(
          await device(
            `/ios-devices/${id}`,
            jsonRequest("PATCH", { name: "Kim's work iPhone" }),
          ),
        ).toMatchObject({ name: "Kim's work iPhone", status: "approved" });
        const registered = await device(
          `/ios-devices/${id}/outcome`,
          jsonRequest("POST", {
            seen: {
              status: "approved",
              approvedAtMs: approval!.approved_at_ms,
            },
            issuerId: "issuer-a",
            outcome: "registered",
          }),
        );
        expect(registered).toMatchObject({
          status: "registered",
          apple_issuer_id: "issuer-a",
        });
        // A stale snapshot writes nothing.
        expect(
          await device(
            `/ios-devices/${id}/outcome`,
            jsonRequest("POST", {
              seen: { status: "approved", approvedAtMs: 1 },
              issuerId: "issuer-a",
              outcome: "missing",
            }),
          ),
        ).toBeNull();
        // The registry's Apple account: of two claims at once, one wins.
        const claims = (await Promise.all(
          ["issuer-a", "issuer-b"].map((issuerId) =>
            adminJson(
              "/ios-devices/account",
              jsonRequest("POST", { issuerId }),
            ),
          ),
        )) as { data: { issuerId: string; claimed: boolean } }[];
        const owner = claims.find(({ data }) => data.claimed)?.data.issuerId;
        expect(claims.filter(({ data }) => data.claimed)).toHaveLength(1);
        expect(claims.map(({ data }) => data.issuerId)).toEqual([owner, owner]);
        // Read without a claim, as the claims answered it.
        expect(await adminJson("/ios-devices/account")).toEqual({
          data: { issuerId: owner },
        });
        const buildId = bundleRow("90").id;
        const marked = await admin(
          "/ios-devices/in-build",
          jsonRequest("POST", { buildId, ids: [id] }),
        );
        expect(marked.status).toBe(204);
        expect((await device(`/ios-devices/udid/${udid}`))?.build_id).toBe(
          buildId,
        );

        const refused = await admin(
          "/ios-devices",
          jsonRequest("POST", { udid: "1234", name: "x", requestedBy: null }),
        );
        expect(refused.status).toBe(400);
        await refused.text();
      } finally {
        await adminJson(`/ios-devices/${id}`, jsonRequest("DELETE"));
      }
      expect(await device(`/ios-devices/udid/${udid}`)).toBeNull();
      expect(
        await device(`/ios-devices/${id}`, jsonRequest("DELETE")),
      ).toBeNull();
      // The account stays the registry's with its rows gone.
      expect(
        ((await adminJson("/ios-devices/account")) as { data: unknown }).data,
      ).toMatchObject({ issuerId: expect.any(String) });
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
