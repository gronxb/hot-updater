import { Hono } from "hono";
import type { Bundle } from "@hot-updater/plugin-core";
import { prepareConfig, isConfigLoaded } from "./config";
import { typiaValidator } from "@hono/typia-validator";
import typia from "typia";

const DEFAULT_PAGE_LIMIT = 20;
const DEFAULT_PAGE_OFFSET = 0;

const api = new Hono()
  // GET /api/config
  .get("/config", async (c) => {
    try {
      const { config } = await prepareConfig();
      return c.json({ console: config.console });
    } catch (error) {
      console.error("Error during config retrieval:", error);
      return c.json({ error: "Failed to retrieve config" }, 500);
    }
  })

  // GET /api/channels
  .get("/channels", async (c) => {
    try {
      const { databasePlugin } = await prepareConfig();
      const channels = await databasePlugin.getChannels();
      return c.json(channels ?? []);
    } catch (error) {
      console.error("Error during channel retrieval:", error);
      return c.json({ error: "Failed to retrieve channels" }, 500);
    }
  })

  // GET /api/config-loaded
  .get("/config-loaded", async (c) => {
    try {
      const configLoaded = isConfigLoaded();
      return c.json({ configLoaded });
    } catch (error) {
      console.error("Error during config loaded retrieval:", error);
      return c.json({ error: "Failed to check config status" }, 500);
    }
  })

  // GET /api/bundles
  .get(
    "/bundles",
    typiaValidator(
      "query",
      typia.createValidate<{
        channel?: string;
        platform?: "ios" | "android";
        limit?: string;
        offset?: string;
      }>(),
    ),
    async (c) => {
      try {
        const query = c.req.valid("query");
        const filters = {
          channel: query.channel ?? undefined,
          platform: query.platform ?? undefined,
          limit: query.limit ? Number(query.limit) : DEFAULT_PAGE_LIMIT,
          offset: query.offset ? Number(query.offset) : DEFAULT_PAGE_OFFSET,
        };

        const { databasePlugin } = await prepareConfig();
        const bundles = await databasePlugin.getBundles({
          where: {
            channel: filters.channel,
            platform: filters.platform,
          },
          limit: filters.limit,
          offset: filters.offset,
        });

        return c.json(bundles ?? []);
      } catch (error) {
        console.error("Error during bundle retrieval:", error);
        return c.json({ error: "Failed to retrieve bundles" }, 500);
      }
    },
  )

  // GET /api/bundles/:bundleId
  .get("/bundles/:bundleId", async (c) => {
    try {
      const bundleId = c.req.param("bundleId");
      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(bundleId);
      return c.json(bundle ?? null);
    } catch (error) {
      console.error("Error during bundle retrieval:", error);
      return c.json({ error: "Failed to retrieve bundle" }, 500);
    }
  })

  // GET /api/bundles/:bundleId/rollout-stats
  .get("/bundles/:bundleId/rollout-stats", async (c) => {
    try {
      const bundleId = c.req.param("bundleId");
      const { databasePlugin } = await prepareConfig();

      if (!databasePlugin.getRolloutStats) {
        return c.json({
          totalDevices: 0,
          promotedCount: 0,
          recoveredCount: 0,
          successRate: 0,
        });
      }

      const stats = await databasePlugin.getRolloutStats(bundleId);
      return c.json(stats);
    } catch (error) {
      console.error("Error during rollout stats retrieval:", error);
      return c.json({ error: "Failed to retrieve rollout stats" }, 500);
    }
  })

  // PATCH /api/bundles/:bundleId
  .patch(
    "/bundles/:bundleId",
    typiaValidator(
      "json",
      typia.createValidate<{
        bundle: Partial<Bundle>;
      }>(),
    ),
    async (c) => {
      try {
        const bundleId = c.req.param("bundleId");
        const { bundle } = c.req.valid("json");

        const { databasePlugin } = await prepareConfig();
        await databasePlugin.updateBundle(bundleId, bundle);
        await databasePlugin.commitBundle();

        return c.json({ success: true });
      } catch (error) {
        console.error("Error during bundle update:", error);
        return c.json({ error: "Failed to update bundle" }, 500);
      }
    },
  )

  // POST /api/bundles
  .post(
    "/bundles",
    typiaValidator("json", typia.createValidate<Bundle>()),
    async (c) => {
      try {
        const bundle = c.req.valid("json");

        const { databasePlugin } = await prepareConfig();
        await databasePlugin.appendBundle(bundle);
        await databasePlugin.commitBundle();

        return c.json({ success: true, bundleId: bundle.id });
      } catch (error) {
        console.error("Error during bundle creation:", error);
        return c.json({ error: "Failed to create bundle" }, 500);
      }
    },
  )

  // DELETE /api/bundles/:bundleId
  .delete("/bundles/:bundleId", async (c) => {
    try {
      const bundleId = c.req.param("bundleId");

      const { databasePlugin } = await prepareConfig();
      const bundle = await databasePlugin.getBundleById(bundleId);

      if (!bundle) {
        return c.json({ error: "Bundle not found" }, 404);
      }

      await databasePlugin.deleteBundle(bundle);
      await databasePlugin.commitBundle();

      return c.json({ success: true });
    } catch (error) {
      console.error("Error during bundle deletion:", error);
      return c.json({ error: "Failed to delete bundle" }, 500);
    }
  });

export { api };
