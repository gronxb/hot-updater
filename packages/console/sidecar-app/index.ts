import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { appRouter } from "./server/trpc";

const port = 1422;

const app = new Hono();

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
  }),
);

console.log(`🚀 Listening on port ${port}`);
export default {
  port,
  fetch: app.fetch,
};
