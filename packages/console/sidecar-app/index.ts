import { trpcServer } from "@hono/trpc-server";
import { Hono, type MiddlewareHandler } from "hono";
import { appRouter } from "./server/trpc";

const port = 1422;

const app = new Hono();

app.use("*", async (c, next) => {
  const userAgent = c.req.header("User-Agent") || "";
  if (userAgent.includes("tauri-plugin-http")) {
    return next();
  }

  return c.text("Not allowed", 403);
});

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
