import type { DatabasePlugin } from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import type { DatabasePluginTestState } from "./databasePluginTestRunner";
import {
  createBundleEventRowFixture,
  createClientAccessKeyRowFixture,
} from "./databaseTestFixtures";

type OfficialDomainTestState = DatabasePluginTestState<DatabasePlugin>;

export const registerDatabasePluginOfficialDomainTests = (
  state: OfficialDomainTestState,
): void => {
  describe("official database domains", () => {
    it("appends and scans analytics events in stable cursor order", async () => {
      const plugin = state.getPlugin();
      const first = createBundleEventRowFixture("701", 100);
      const second = createBundleEventRowFixture("702", 200);
      await plugin.analytics.append(second);
      await plugin.analytics.append(first);

      await expect(
        plugin.analytics.scan({ beforeReceivedAtMs: 201, limit: 1 }),
      ).resolves.toEqual([first]);
      await expect(
        plugin.analytics.scan({
          after: { receivedAtMs: first.received_at_ms, id: first.id },
          beforeReceivedAtMs: 201,
          limit: 1,
        }),
      ).resolves.toEqual([second]);
    });

    it("creates, lists, resolves, and revokes client access keys", async () => {
      const plugin = state.getPlugin();
      const first = createClientAccessKeyRowFixture("801", 100);
      const second = createClientAccessKeyRowFixture("802", 200);

      await expect(plugin.clientAccessKeys.create(first)).resolves.toBe(
        "created",
      );
      await expect(plugin.clientAccessKeys.create(first)).resolves.toBe(
        "existing",
      );
      await expect(plugin.clientAccessKeys.create(second)).resolves.toBe(
        "created",
      );
      await expect(
        plugin.clientAccessKeys.findByHash(first.hash),
      ).resolves.toEqual(first);
      await expect(plugin.clientAccessKeys.list()).resolves.toEqual([
        second,
        first,
      ]);
      await expect(
        plugin.clientAccessKeys.revoke({ id: first.id, revokedAtMs: 300 }),
      ).resolves.toEqual({ ...first, revoked_at_ms: 300 });
    });
  });
};
