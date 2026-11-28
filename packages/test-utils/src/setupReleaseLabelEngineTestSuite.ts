import {
  createEngine,
  DatabaseConstraintError,
  SETTINGS_TABLE,
  toolingTargetOf,
  type Deployment,
  type HotUpdaterCoreApi,
  type ReleaseRow,
} from "@hot-updater/plugin-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LATER_RELEASE_CATALOG_FIELD,
  writeCatalogFromLaterRelease,
} from "./catalogFromLaterRelease";
import { createMeasuredDatabase } from "./createMeasuredDatabase";
import { createBundleFixture } from "./databaseTestFixtures";
import type { ReadBudgetSuiteOptions } from "./setupReadBudgetTestSuite";

/** The backend under test, as `setupReadBudgetTestSuite` takes it. */
export type ReleaseLabelEngineSuiteOptions = Pick<
  ReadBudgetSuiteOptions,
  "name" | "createAdapter"
>;

// Small native pages, so the fill pages through each pair.
const NATIVE_PAGE_SIZE = 2;

/**
 * Release labels on a backend's own rows, which no HTTP API writes: the
 * releases a server of an earlier release left without labels and without
 * counters, which the fill labels per channel and platform in ID order,
 * concurrent fills and a deploy included, rebuilding the catalogs compiled
 * without them; and the label index, which refuses a second row with a label
 * and holds any number without one. Rows are written as an earlier server
 * wrote them through a second engine on the same adapter. It also writes a
 * catalog as a later release compiles it, with a field this one does not
 * know, which core verifies, never rewrites, and refuses to change. Register
 * it beside `setupReadBudgetTestSuite`, with the same options.
 */
export const setupReleaseLabelEngineTestSuite = (
  options: ReleaseLabelEngineSuiteOptions,
): void => {
  describe(`${options.name} release labels`, () => {
    let created: Awaited<
      ReturnType<ReleaseLabelEngineSuiteOptions["createAdapter"]>
    >;
    let core: HotUpdaterCoreApi;
    let raw: ReturnType<typeof createEngine>["core"];

    beforeAll(async () => {
      created = await options.createAdapter({
        tables: [...toolingTargetOf([]).schema.tables, SETTINGS_TABLE],
        nativePageSize: NATIVE_PAGE_SIZE,
      });
      ({ core } = await createMeasuredDatabase(created.adapter, []));
      raw = createEngine({ name: "raw", adapter: created.adapter }).core;
    }, 180_000);
    afterAll(async () => {
      await created?.cleanup?.();
    }, 60_000);

    let suffix = 0;
    let namespace = 0;
    const channel = (name: string) => `${name}-${namespace}`;
    const deploy = async (
      name: string,
      {
        platform = "ios",
        fingerprintHash = null,
      }: {
        readonly platform?: "ios" | "android";
        readonly fingerprintHash?: string | null;
      } = {},
    ): Promise<ReleaseRow> => {
      suffix += 1;
      const deployment: Deployment = {
        bundle: {
          ...createBundleFixture(String(9000 + suffix)),
          platform,
        },
        release: {
          channel: channel(name),
          enabled: true,
          fingerprintHash,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: fingerprintHash === null ? "1.0.x" : null,
        },
      };
      const [result] = await core.deploy([deployment]);
      return result!.release!;
    };
    /** Takes the labels off `releases` and drops their pairs' counters, as an earlier server left them. */
    const asBeforeLabels = async (releases: readonly ReleaseRow[]) => {
      await raw.transaction(async (tx) => {
        const counters = new Set<string>();
        for (const { id } of releases) {
          const row = await tx.findOne("releases", { id });
          tx.update("releases", row!, { label: null });
          counters.add(`releases/${row!.platform}/${row!.channel_id}`);
        }
        for (const id of counters) {
          const counter = await tx.findOne("label_sequences", { id });
          if (counter !== null) await tx.delete("label_sequences", counter);
        }
      });
    };
    const labelOf = async (id: string) => (await core.getRelease(id))?.label;

    it("labels releases an earlier server wrote in ID order per channel and platform, rebuilds their catalogs, and a deploy then takes the next", async () => {
      namespace += 1;
      const releases = [
        await deploy("fill"),
        await deploy("fill", { fingerprintHash: "fp-a" }),
        await deploy("fill"),
        await deploy("fill", { platform: "android" }),
        await deploy("fill", { fingerprintHash: "fp-b" }),
      ];
      await asBeforeLabels(releases);
      // Each catalog as the earlier server compiled it: without labels.
      for (const scope of new Set(releases.map((row) => row.scope_key))) {
        await core.rebuildReleaseCatalog(scope);
      }

      // A dry run labels nothing, so no catalog differs by labels yet.
      await expect(core.fillReleaseLabels({ dryRun: true })).resolves.toEqual({
        releases: 5,
        catalogs: 0,
      });
      await expect(core.fillReleaseLabels()).resolves.toEqual({
        releases: 5,
        catalogs: 4,
      });

      // In ID order: releases created in one millisecond may sort either way.
      const inIdOrder = (rows: readonly ReleaseRow[]) =>
        rows.map(({ id }) => id).sort();
      const ios = inIdOrder(
        releases.filter(({ platform }) => platform === "ios"),
      );
      const labels: Record<string, number | null | undefined> = {};
      for (const { id } of releases) labels[id] = await labelOf(id);
      expect(labels).toEqual({
        ...Object.fromEntries(ios.map((id, index) => [id, index + 1])),
        [releases[3]!.id]: 1,
      });
      const served = (
        JSON.parse(
          (await core.getReleaseCatalogRow(releases[0]!.scope_key))!.payload,
        ) as { releaseDescriptors: { releaseId: string; label?: number }[] }
      ).releaseDescriptors;
      expect(
        Object.fromEntries(
          served.map(({ releaseId, label }) => [releaseId, label]),
        ),
      ).toEqual({
        [releases[0]!.id]: labels[releases[0]!.id],
        [releases[2]!.id]: labels[releases[2]!.id],
      });
      await expect(core.fillReleaseLabels({ dryRun: true })).resolves.toEqual({
        releases: 0,
        catalogs: 0,
      });
      await expect(deploy("fill")).resolves.toMatchObject({ label: 5 });
    });

    it("verifies a catalog a later release compiled with a field this one doesn't know, and refuses to rewrite it without that field", async () => {
      namespace += 1;
      const first = await deploy("later");
      await deploy("later");
      const scopeKey = first.scope_key;
      const payload = await writeCatalogFromLaterRelease(raw, scopeKey);
      const counter = async () =>
        (await raw.findOne("label_sequences", {
          id: `releases/ios/${first.channel_id}`,
        }))!.last_label;
      const before = await counter();
      const stored = async () => (await core.getReleaseCatalogRow(scopeKey))!;
      const generation = (await stored()).generation;

      await expect(
        core.preflightReleaseCatalogRebuild(scopeKey),
      ).resolves.toMatchObject({ changed: false, labelsOnly: false });
      await expect(core.rebuildReleaseCatalog(scopeKey)).resolves.toMatchObject(
        { changed: false },
      );
      await expect(core.fillReleaseLabels()).resolves.toMatchObject({
        catalogs: 0,
      });

      const refusal = {
        code: "CATALOG_FROM_LATER_RELEASE",
        message:
          'The ios release catalog of channel "later-' +
          String(namespace) +
          '" was written by a later Hot Updater.\nUpgrade hot-updater, then try again.',
      };
      await expect(deploy("later")).rejects.toMatchObject(refusal);
      await expect(
        core.updateReleasePolicy({
          releaseId: first.id,
          patch: { message: "changed" },
        }),
      ).rejects.toMatchObject(refusal);
      await expect(
        core.preflightReleasePolicy({
          releaseId: first.id,
          patch: { message: "changed" },
        }),
      ).rejects.toMatchObject(refusal);

      expect(await stored()).toMatchObject({ generation, payload });
      expect(payload).toContain(LATER_RELEASE_CATALOG_FIELD);
      expect(await counter()).toBe(before);
      await expect(
        core.listReleases({
          filter: { kind: "scope", scopeKey },
          limit: 10,
        }),
      ).resolves.toHaveLength(2);
      expect((await core.getRelease(first.id))?.message).toBeNull();
    });

    it("labels each release once when fills run beside a deploy that needs one", async () => {
      namespace += 1;
      const releases = [];
      for (let index = 0; index < 5; index += 1) {
        releases.push(await deploy("race"));
      }
      await asBeforeLabels(releases);

      const [, , deployed] = await Promise.all([
        core.fillReleaseLabels(),
        core.fillReleaseLabels(),
        deploy("race"),
      ]);

      const labels: Record<string, number | null | undefined> = {};
      for (const { id } of releases) labels[id] = await labelOf(id);
      expect(labels).toEqual(
        Object.fromEntries(
          releases
            .map(({ id }) => id)
            .sort()
            .map((id, index) => [id, index + 1]),
        ),
      );
      expect(deployed.label).toBe(6);
    });

    it("refuses a second release with a label in its channel and platform, and holds any number without one", async () => {
      namespace += 1;
      const releases = [
        await deploy("unique"),
        await deploy("unique"),
        await deploy("unique"),
      ];
      const set = (id: string, label: number | null) =>
        raw.transaction(async (tx) => {
          const row = await tx.findOne("releases", { id });
          tx.update("releases", row!, { label });
        });

      await set(releases[0]!.id, null);
      await set(releases[1]!.id, null);
      await expect(set(releases[2]!.id, 2)).resolves.toBeUndefined();
      await expect(set(releases[0]!.id, 2)).rejects.toBeInstanceOf(
        DatabaseConstraintError,
      );
      // Another channel holds the same number.
      const other = await deploy("unique-other");
      expect(other.label).toBe(1);
      await expect(set(other.id, 2)).resolves.toBeUndefined();

      // As the deploys labeled them, for the fill of the other tests.
      await set(other.id, 1);
      await set(releases[2]!.id, 3);
      await set(releases[1]!.id, 2);
      await set(releases[0]!.id, 1);
      await expect(
        core.getReleaseByLabel({
          channel: channel("unique"),
          platform: "ios",
          label: 3,
        }),
      ).resolves.toMatchObject({ id: releases[2]!.id });
    });
  });
};
