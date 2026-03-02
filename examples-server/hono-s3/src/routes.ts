import { Hono } from "hono";
import { hotUpdater } from "./db.js";
import {
  handleIncrementalAppVersion,
  handleIncrementalContent,
  handleIncrementalFingerprint,
} from "./incremental.js";

const app = new Hono();

app.get(
  "/hot-updater/incremental/app-version/:platform/:appVersion/:channel/:minBundleId/:bundleId",
  handleIncrementalAppVersion,
);
app.get(
  "/hot-updater/incremental/fingerprint/:platform/:fingerprintHash/:channel/:minBundleId/:bundleId",
  handleIncrementalFingerprint,
);
app.get("/hot-updater/incremental/content/:hash", handleIncrementalContent);

// Mount Hot Updater handler for all /hot-updater/* routes
app.on(["POST", "GET", "DELETE"], "/hot-updater/*", async (c) => {
  return hotUpdater.handler(c.req.raw);
});

export default app;
