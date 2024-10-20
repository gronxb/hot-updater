import { hotUpdaterRouter } from "./routers/hot-updater";
import { createTRPCRouter } from "./utils";

export const appRouter = createTRPCRouter({
  hotUpdater: hotUpdaterRouter,
});

export type AppRouter = typeof appRouter;
