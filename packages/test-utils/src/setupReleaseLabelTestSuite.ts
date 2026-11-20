import {
  createEngine,
  DatabaseConstraintError,
  type BundleRow,
  type EngineDatabase,
  type ReleaseRow,
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
 * Release labels on a provider's database: deploys through the admin API
 * take each channel and platform's next label, concurrent ones never the
 * same, the label index refuses a second row with a label and holds any
 * number without one, and the fill labels those in ID order. Rows without a
 * label are written through the engine, as a server of an earlier release
 * wrote them.
 */
export const setupReleaseLabelTestSuite = (options: {
  readonly getClient: () => HttpTestClient;
  readonly getDatabase: () => EngineDatabase;
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
    const channel = () => `labels-${namespace}`;
    const deploy = (suffix: string, fingerprintHash: string | null = null) =>
      api.deploy({
        bundle: toDeployBundle(bundleRow(suffix)),
        release: {
          channel: channel(),
          enabled: true,
          fingerprintHash,
          message: null,
          shouldForceUpdate: false,
          targetAppVersion: fingerprintHash === null ? "1.0.x" : null,
        },
      });
    const byLabel = async (label: number) =>
      (
        (await adminJson(
          `/release-labels?channel=${encodeURIComponent(channel())}&platform=ios&label=${label}`,
        )) as { data: ReleaseRow | null }
      ).data;

    it("labels a channel and platform's deploys in order, and finds each by its label", async () => {
      const first = await deploy("1");
      const second = await deploy("2");

      expect([first.label, second.label]).toEqual([1, 2]);
      await expect(byLabel(2)).resolves.toMatchObject({
        id: second.id,
        label: 2,
      });
      await expect(byLabel(3)).resolves.toBeNull();
    });

    it("never gives concurrent deploys one label", async () => {
      await deploy("10");

      const releases = await Promise.all(
        ["11", "12", "13", "14"].map((suffix) =>
          deploy(suffix, `fingerprint-${suffix}`),
        ),
      );

      expect(releases.map(({ label }) => label).sort()).toEqual([2, 3, 4, 5]);
    });

    it("refuses a second row with a label, holds any number without one, and fills them in ID order", async () => {
      const releases: ReleaseRow[] = [];
      for (const suffix of ["21", "22", "23"]) {
        releases.push(await deploy(suffix));
      }
      const engine = createEngine(options.getDatabase());
      // As a server of an earlier release left them: no labels, no counter.
      const counterId = `releases/ios/${releases[0]!.channel_id}`;
      await engine.core.transaction(async (tx) => {
        for (const { id } of releases) {
          const row = await tx.findOne("releases", { id });
          tx.update("releases", row!, { label: null });
        }
        const counter = await tx.findOne("label_sequences", { id: counterId });
        await tx.delete("label_sequences", counter!);
      });
      for (const { id } of releases) {
        await expect(
          adminJson(`/releases/${encodeURIComponent(id)}`),
        ).resolves.toMatchObject({ data: { label: null } });
      }
      await engine.core.transaction(async (tx) => {
        const row = await tx.findOne("releases", { id: releases[0]!.id });
        tx.update("releases", row!, { label: 7 });
      });
      await expect(
        engine.core.transaction(async (tx) => {
          const row = await tx.findOne("releases", { id: releases[1]!.id });
          tx.update("releases", row!, { label: 7 });
        }),
      ).rejects.toBeInstanceOf(DatabaseConstraintError);
      await engine.core.transaction(async (tx) => {
        const row = await tx.findOne("releases", { id: releases[0]!.id });
        tx.update("releases", row!, { label: null });
      });

      const filled = (await adminJson(
        "/release-labels/fill",
        jsonRequest("POST", {}),
      )) as { data: { releases: number; catalogs: number } };

      expect(filled.data.releases).toBeGreaterThanOrEqual(3);
      const labels: (number | null | undefined)[] = [];
      for (const { id } of releases) {
        labels.push(
          (
            (await adminJson(`/releases/${encodeURIComponent(id)}`)) as {
              data: ReleaseRow;
            }
          ).data.label,
        );
      }
      expect(labels).toEqual([1, 2, 3]);
      await expect(deploy("24")).resolves.toMatchObject({ label: 4 });
    });
  });
};
