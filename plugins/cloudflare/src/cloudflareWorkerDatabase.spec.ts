import { getCapabilityContributions } from "@hot-updater/plugin-core/internal/capabilities";
import { expect, it } from "vitest";

import { d1WorkerDatabase, type D1Like } from "./cloudflareWorkerDatabase";

const db: D1Like = {
  prepare: () => ({
    bind: () => ({
      all: async () => ({
        results: [{ channel: "production" }],
      }),
    }),
  }),
};

it("uses the configured D1 binding without request context", async () => {
  const plugin = d1WorkerDatabase(db);

  const channels = plugin.getChannels?.();

  await expect(channels).resolves.toEqual(["production"]);
});

it("attaches a bounded Analytics provider capability", () => {
  const plugin = d1WorkerDatabase(db);
  const [contribution] = getCapabilityContributions(plugin);
  if (contribution === undefined) {
    throw new TypeError("Expected the D1 Analytics capability contribution.");
  }

  const provider = contribution.token.parse(
    contribution.create({ database: plugin, storages: [] }),
  );

  expect(contribution.token.id).toBe("hot-updater.analytics.provider@1");
  expect(provider).toMatchObject({ mode: "bounded" });
});
