import type { UpdateSource } from "@hot-updater/core";

import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

const router = t.router;
const publicProcedure = t.procedure;

const updateSources: UpdateSource[] = [
  {
    platform: "ios",
    targetVersion: "1.x.x",
    enabled: true,
    bundleVersion: 1,
    forceUpdate: false,
    file: "http://example.com/bundle.zip",
    hash: "hash",
  },
];

export const appRouter = router({
  updateSources: publicProcedure.query(async () => {
    return updateSources;
  }),
  push: publicProcedure.mutation(async () => {
    updateSources.push({
      platform: "ios",
      targetVersion: "1.x.x",
      enabled: true,
      bundleVersion: 1,
      forceUpdate: false,
      file: "http://example.com/bundle.zip",
      hash: "hash",
    });
    return updateSources;
  }),
});

export type AppRouter = typeof appRouter;
